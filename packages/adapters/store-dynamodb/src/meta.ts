import type { ArchiveState, ErasureRequest, MetaRepo } from "@errtraq/core";
import { VersionConflictError } from "@errtraq/core/store";
import { DynamoStoreError } from "./errors.js";
import { partition, sortKey } from "./keys.js";
import {
  type Driver,
  dataItem,
  get,
  itemData,
  pageIndex,
  s,
} from "./repository-base.js";

const archivePk = (projectId: string) => partition("ARCHIVE", projectId);
const erasurePk = (projectId: string, id: string) =>
  partition("ERASURE", projectId, id);
const globalHash = partition("ERASUREIDX", "all");
const projectHash = (projectId: string) =>
  partition("ERASUREIDX", "project", projectId);
const stateHash = (state: string) => partition("ERASUREIDX", "state", state);
const projectStateHash = (projectId: string, state: string) =>
  partition("ERASUREIDX", "project-state", projectId, state);
async function cas<T extends { version: number }>(
  driver: Driver,
  PK: string,
  expected: number | null,
  next: T,
  attributes: Record<string, { S: string }> = {},
): Promise<void> {
  if (
    (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) ||
    next.version !== (expected ?? -1) + 1
  )
    throw new VersionConflictError("Version conflict");
  const item = {
    ...dataItem(PK, next),
    version: { N: String(next.version) },
    ...attributes,
  };
  const condition =
    expected === null
      ? { ConditionExpression: "attribute_not_exists(PK)" }
      : {
          ConditionExpression: "#v = :expected",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":expected": { N: String(expected) } },
        };
  try {
    await driver.request("PutItem", {
      TableName: driver.table,
      Item: item,
      ...condition,
    });
  } catch (error) {
    if (
      error instanceof DynamoStoreError &&
      !error.ambiguous &&
      error.providerCode === "ConditionalCheckFailedException"
    )
      throw new VersionConflictError("Version conflict");
    throw error;
  }
}
export function metaRepository(driver: Driver): MetaRepo {
  return {
    getArchiveState: async (projectId) =>
      itemData<ArchiveState>(await get(driver, archivePk(projectId))),
    compareAndSetArchiveState: async (projectId, expected, next) => {
      if (next.projectId !== projectId)
        throw new VersionConflictError("Version conflict");
      await cas(driver, archivePk(projectId), expected, next);
    },
    getErasureRequest: async (projectId, id) =>
      itemData<ErasureRequest>(await get(driver, erasurePk(projectId, id))),
    compareAndSetErasureRequest: async (projectId, id, expected, next) => {
      if (next.projectId !== projectId || next.id !== id)
        throw new VersionConflictError("Version conflict");
      const composite = `${sortKey(projectId)}${sortKey(id)}`;
      await cas(driver, erasurePk(projectId, id), expected, next, {
        GSI8PK: s(globalHash),
        GSI8SK: s(composite),
        GSI9PK: s(projectHash(projectId)),
        GSI9SK: s(sortKey(id)),
        GSI10PK: s(stateHash(next.state)),
        GSI10SK: s(composite),
        GSI11PK: s(projectStateHash(projectId, next.state)),
        GSI11SK: s(sortKey(id)),
      });
    },
    listErasureRequests: ({ projectId, state, cursor, limit }) => {
      const index = projectId ? (state ? 11 : 9) : state ? 10 : 8;
      const hash = projectId
        ? state
          ? projectStateHash(projectId, state)
          : projectHash(projectId)
        : state
          ? stateHash(state)
          : globalHash;
      return pageIndex<ErasureRequest>(
        driver,
        [
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "erasure-all",
          "erasure-project",
          "erasure-state",
          "erasure-project-state",
        ][index] ?? "",
        `GSI${index}PK`,
        `GSI${index}SK`,
        hash,
        JSON.stringify(["erasures", projectId ?? null, state ?? null]),
        cursor,
        limit,
      );
    },
  };
}
