import type {
  ApiToken,
  Org,
  Page,
  Project,
  ProjectKey,
  ProjectRepo,
} from "@errtraq/core";
import { ConflictError } from "@errtraq/core/store";
import { DynamoStoreError } from "./errors.js";
import { partition, sortKey } from "./keys.js";
import {
  cancelled,
  conditionFor,
  conflict,
  contentionDelay,
  type Driver,
  dataItem,
  get,
  itemData,
  pageIndex,
  primary,
  s,
} from "./repository-base.js";

const indexPartition = (...parts: string[]) => partition("ENTITY", ...parts);
const ownerKey = (kind: string, id: string) => partition("KEYID", kind, id);
async function markerLookup<T>(
  driver: Driver,
  marker: string,
): Promise<T | null> {
  const alias = await get(driver, marker);
  const owner = alias?.owner?.S;
  if (!owner) return null;
  return itemData<T>(await get(driver, owner));
}
async function writeUnique<T>(
  driver: Driver,
  PK: string,
  value: T,
  marker: string,
  oldMarker: (old: T) => string,
  index?: { partition: string; sort: string },
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const previous = await get(driver, PK);
    const old = itemData<T>(previous);
    const before = old === null ? undefined : oldMarker(old);
    const writes: Record<string, unknown>[] = [
      {
        Put: {
          TableName: driver.table,
          Item: dataItem(PK, value, index),
          ...conditionFor(previous),
        },
      },
      {
        Put: {
          TableName: driver.table,
          Item: { ...primary(marker), owner: s(PK) },
          ConditionExpression: "attribute_not_exists(PK) OR #owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": s(PK) },
        },
      },
    ];
    if (before && before !== marker)
      writes.push({
        Delete: {
          TableName: driver.table,
          Key: primary(before),
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": s(PK) },
        },
      });
    try {
      await driver.request("TransactWriteItems", { TransactItems: writes });
      return;
    } catch (error) {
      if (!cancelled(error)) throw error;
      const claimed = await get(driver, marker);
      if (claimed?.owner?.S && claimed.owner.S !== PK) conflict();
      await contentionDelay(attempt);
    }
  }
  throw new DynamoStoreError(
    "DynamoDB natural-key write contention limit reached",
    undefined,
    true,
  );
}
async function writeDirectUnique<T>(
  driver: Driver,
  kind: string,
  id: string,
  natural: string,
  value: T,
  index?: { partition: string; sort: string },
): Promise<void> {
  const idMarker = ownerKey(kind, id),
    PK = partition(kind === "project-key" ? "KEY" : "TOKEN", natural);
  for (let attempt = 0; attempt < 12; attempt++) {
    const alias = await get(driver, idMarker);
    const oldPK = alias?.owner?.S;
    const previous = oldPK ? await get(driver, oldPK) : undefined;
    const current = oldPK === PK ? previous : await get(driver, PK);
    if (current && oldPK !== PK)
      throw new ConflictError("Natural key already exists");
    const writes: Record<string, unknown>[] = [
      {
        Put: {
          TableName: driver.table,
          Item: dataItem(PK, value, index),
          ...conditionFor(current),
        },
      },
      {
        Put: {
          TableName: driver.table,
          Item: {
            ...primary(idMarker),
            owner: s(PK),
            revision: s(crypto.randomUUID()),
          },
          ...conditionFor(alias),
        },
      },
    ];
    if (oldPK && oldPK !== PK)
      writes.push({
        Delete: {
          TableName: driver.table,
          Key: primary(oldPK),
          ...conditionFor(previous),
        },
      });
    try {
      await driver.request("TransactWriteItems", { TransactItems: writes });
      return;
    } catch (error) {
      if (!cancelled(error)) throw error;
      const found = await get(driver, PK),
        marker = await get(driver, idMarker);
      if (found && marker?.owner?.S !== PK) conflict();
      await contentionDelay(attempt);
    }
  }
  throw new DynamoStoreError(
    "DynamoDB key write contention limit reached",
    undefined,
    true,
  );
}
export function projectRepository(driver: Driver): ProjectRepo {
  const orgPk = (id: string) => partition("ORG", id);
  const orgSlug = (slug: string) => partition("ORGSLUG", slug);
  const projectPk = (id: string) => partition("PROJECT", id);
  const projectSlug = (orgId: string, slug: string) =>
    partition("PROJECTSLUG", orgId, slug);
  const keyPk = (publicKey: string) => partition("KEY", publicKey);
  const tokenPk = (hash: string) => partition("TOKEN", hash);
  return {
    getOrg: async (id) => itemData<Org>(await get(driver, orgPk(id))),
    getOrgBySlug: (slug) => markerLookup<Org>(driver, orgSlug(slug)),
    putOrg: (org) =>
      writeUnique(driver, orgPk(org.id), org, orgSlug(org.slug), (old) =>
        orgSlug(old.slug),
      ),
    get: async (id) => itemData<Project>(await get(driver, projectPk(id))),
    getProjectBySlug: (orgId, slug) =>
      markerLookup<Project>(driver, projectSlug(orgId, slug)),
    put: (project) =>
      writeUnique(
        driver,
        projectPk(project.id),
        project,
        projectSlug(project.orgId, project.slug),
        (old) => projectSlug(old.orgId, old.slug),
        { partition: indexPartition("projects"), sort: sortKey(project.id) },
      ),
    list: (cursor, limit) =>
      pageIndex<Project>(
        driver,
        "entity-list",
        "GSI7PK",
        "GSI7SK",
        indexPartition("projects"),
        "projects",
        cursor,
        limit,
      ),
    getKey: async (publicKey) =>
      itemData<ProjectKey>(await get(driver, keyPk(publicKey))),
    putKey: (key) =>
      writeDirectUnique(driver, "project-key", key.id, key.publicKey, key, {
        partition: indexPartition("keys", key.projectId),
        sort: sortKey(key.id),
      }),
    getOrCreateActiveKey: async (key) => {
      const guard = ownerKey("active", key.projectId);
      for (let attempt = 0; attempt < 12; attempt++) {
        const previous = await get(driver, guard);
        const publicKey = previous?.owner?.S;
        const existing = publicKey
          ? itemData<ProjectKey>(await get(driver, keyPk(publicKey)))
          : null;
        if (existing && !existing.revokedAt) return existing;
        const PK = keyPk(key.publicKey),
          marker = ownerKey("project-key", key.id);
        const writes = [
          {
            Put: {
              TableName: driver.table,
              Item: {
                ...primary(guard),
                owner: s(key.publicKey),
                revision: s(crypto.randomUUID()),
              },
              ...conditionFor(previous),
            },
          },
          {
            Put: {
              TableName: driver.table,
              Item: dataItem(PK, key, {
                partition: indexPartition("keys", key.projectId),
                sort: sortKey(key.id),
              }),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: driver.table,
              Item: {
                ...primary(marker),
                owner: s(PK),
                revision: s(crypto.randomUUID()),
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ];
        try {
          await driver.request("TransactWriteItems", { TransactItems: writes });
          return key;
        } catch (error) {
          if (!cancelled(error)) throw error;
          await contentionDelay(attempt);
        }
      }
      throw new DynamoStoreError(
        "DynamoDB active-key contention limit reached",
        undefined,
        true,
      );
    },
    listKeys: async (projectId) => {
      const hash = indexPartition("keys", projectId),
        result: ProjectKey[] = [];
      let cursor: import("@errtraq/core").Cursor | null = null;
      do {
        const page: Page<ProjectKey> = await pageIndex<ProjectKey>(
          driver,
          "entity-list",
          "GSI7PK",
          "GSI7SK",
          hash,
          `keys:${projectId}`,
          cursor ?? undefined,
          100,
        );
        result.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return result;
    },
    getTokenByHash: async (hash) =>
      itemData<ApiToken>(await get(driver, tokenPk(hash))),
    createToken: async (token) => {
      const PK = tokenPk(token.tokenHash),
        marker = ownerKey("token", token.id);
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          await driver.request("TransactWriteItems", {
            TransactItems: [
              {
                Put: {
                  TableName: driver.table,
                  Item: dataItem(PK, token),
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
              {
                Put: {
                  TableName: driver.table,
                  Item: {
                    ...primary(marker),
                    owner: s(PK),
                    revision: s(crypto.randomUUID()),
                  },
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
            ],
          });
          return true;
        } catch (error) {
          if (!cancelled(error)) throw error;
          if (await get(driver, PK)) return false;
          if (await get(driver, marker))
            throw new ConflictError("Token ID already exists");
        }
      }
      throw new DynamoStoreError(
        "DynamoDB token creation contention limit reached",
        undefined,
        true,
      );
    },
    putToken: (token) =>
      writeDirectUnique(driver, "token", token.id, token.tokenHash, token),
  };
}
export { indexPartition, markerLookup, writeUnique };
