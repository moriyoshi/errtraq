import type {
  ApiToken,
  Org,
  Project,
  ProjectKey,
  ProjectRepo,
} from "@moriyoshi/errtraq-core";
import {
  ConflictError,
  summarizeApiToken,
} from "@moriyoshi/errtraq-core/store";
import {
  encodeFields,
  type FirestoreClient,
  NAME_FIELD,
  type RawDocument,
  type Write,
} from "@moriyoshi/errtraq-firestore-rest";
import {
  create,
  entityData,
  entityFields,
  field,
  naturalKey,
  pageQuery,
  remove,
  segment,
  set,
} from "./base.js";

export const orgPath = (id: string) => `orgs/${segment(id)}`;
export const projectPath = (id: string) => `projects/${segment(id)}`;
export const markerPath = (kind: string, hash: string) =>
  `markers/${kind}|${hash}`;
const owner = (marker: RawDocument | null): string | undefined => {
  const value = marker ? field(marker, "owner") : undefined;
  return typeof value === "string" ? value : undefined;
};
const markerFields = (ownerId: string) => encodeFields({ owner: ownerId });

/**
 * Write a document together with its natural-key marker in one transaction: another owner of the
 * marker raises ConflictError, and an owner that changed its natural key releases the old marker.
 */
async function putUnique(
  client: FirestoreClient,
  o: {
    path: string;
    fields: ReturnType<typeof entityFields>;
    id: string;
    newMarker: string;
    /** The marker path the stored document currently holds, when it differs. */
    oldMarker: (existing: RawDocument) => Promise<string>;
    conflict: string;
  },
): Promise<void> {
  await client.runTransaction(async (tx) => {
    const [existing, marker] = await tx.batchGet([o.path, o.newMarker]);
    if (marker && owner(marker) !== o.id) throw new ConflictError(o.conflict);
    const writes: Write[] = [];
    if (existing) {
      const old = await o.oldMarker(existing);
      if (old !== o.newMarker) writes.push(remove(old));
    }
    writes.push(set(o.path, o.fields), set(o.newMarker, markerFields(o.id)));
    await tx.commit(writes);
  });
}

async function viaMarker<T>(
  client: FirestoreClient,
  marker: string,
  target: (ownerId: string) => string,
): Promise<T | null> {
  const found = owner(await client.get(marker));
  if (found === undefined) return null;
  const doc = await client.get(target(found));
  return doc ? entityData<T>(doc) : null;
}

export function projectRepository(client: FirestoreClient): ProjectRepo {
  const orgSlug = (slug: string) =>
    naturalKey("org-slug", slug).then((h) => markerPath("org-slug", h));
  const projectSlug = (orgId: string, slug: string) =>
    naturalKey("project-slug", orgId, slug).then((h) =>
      markerPath("project-slug", h),
    );
  const keyDoc = async (publicKey: string) =>
    `keys/${await naturalKey("key", publicKey)}`;
  const tokenDoc = async (hash: string) =>
    `tokens/${await naturalKey("token", hash)}`;
  const keyIdMarker = (id: string) => markerPath("key-id", segment(id));
  const tokenIdMarker = (id: string) => markerPath("token-id", segment(id));

  return {
    getOrg: async (id) => {
      const doc = await client.get(orgPath(id));
      return doc ? entityData<Org>(doc) : null;
    },
    getOrgBySlug: async (slug) =>
      viaMarker<Org>(client, await orgSlug(slug), orgPath),
    putOrg: async (org) =>
      putUnique(client, {
        path: orgPath(org.id),
        fields: entityFields({ id: org.id }, org),
        id: org.id,
        newMarker: await orgSlug(org.slug),
        oldMarker: (existing) => orgSlug(entityData<Org>(existing).slug),
        conflict: "Organization slug exists",
      }),
    get: async (id) => {
      const doc = await client.get(projectPath(id));
      return doc ? entityData<Project>(doc) : null;
    },
    getProjectBySlug: async (orgId, slug) =>
      viaMarker<Project>(client, await projectSlug(orgId, slug), projectPath),
    put: async (project) =>
      putUnique(client, {
        path: projectPath(project.id),
        fields: entityFields({ id: project.id, orgId: project.orgId }, project),
        id: project.id,
        newMarker: await projectSlug(project.orgId, project.slug),
        oldMarker: (existing) => {
          const old = entityData<Project>(existing);
          return projectSlug(old.orgId, old.slug);
        },
        conflict: "Project slug exists",
      }),
    list: (cursor, limit) =>
      pageQuery(client, {
        query: {
          parent: "",
          collection: "projects",
          orderBy: [{ field: NAME_FIELD, direction: "ASC" }],
        },
        scope: "projects",
        cursor,
        limit,
        read: entityData<Project>,
      }),
    listByOrg: (orgId, cursor, limit) =>
      pageQuery(client, {
        query: {
          parent: "",
          collection: "projects",
          where: [
            { field: "orgId", op: "EQUAL", value: { stringValue: orgId } },
          ],
          orderBy: [{ field: NAME_FIELD, direction: "ASC" }],
        },
        scope: JSON.stringify(["projects", orgId]),
        cursor,
        limit,
        read: entityData<Project>,
      }),

    getKey: async (publicKey) => {
      const doc = await client.get(await keyDoc(publicKey));
      return doc ? entityData<ProjectKey>(doc) : null;
    },
    putKey: async (key) => {
      const path = await keyDoc(key.publicKey);
      const idMarker = keyIdMarker(key.id);
      await client.runTransaction(async (tx) => {
        const [existing, marker] = await tx.batchGet([path, idMarker]);
        if (existing && entityData<ProjectKey>(existing).id !== key.id)
          throw new ConflictError("Key exists");
        const writes: Write[] = [];
        const previous = owner(marker);
        if (previous !== undefined && previous !== path)
          writes.push(remove(previous));
        writes.push(
          set(
            path,
            entityFields({ id: key.id, projectId: key.projectId }, key),
          ),
          set(idMarker, markerFields(path)),
        );
        await tx.commit(writes);
      });
    },
    getOrCreateActiveKey: async (key) => {
      const path = await keyDoc(key.publicKey);
      const idMarker = keyIdMarker(key.id);
      return client.runTransaction(async (tx) => {
        const docs = await tx.runQuery({
          parent: "",
          collection: "keys",
          where: [
            {
              field: "projectId",
              op: "EQUAL",
              value: { stringValue: key.projectId },
            },
          ],
        });
        for (const doc of docs) {
          const existing = entityData<ProjectKey>(doc);
          if (!existing.revokedAt) return existing;
        }
        const [same, marker] = await tx.batchGet([path, idMarker]);
        if (same || marker) throw new ConflictError("Key exists");
        await tx.commit([
          create(
            path,
            entityFields({ id: key.id, projectId: key.projectId }, key),
          ),
          create(idMarker, markerFields(path)),
        ]);
        return key;
      });
    },
    listKeys: async (projectId) =>
      (
        await client.runQuery({
          parent: "",
          collection: "keys",
          where: [
            {
              field: "projectId",
              op: "EQUAL",
              value: { stringValue: projectId },
            },
          ],
        })
      ).map((doc) => entityData<ProjectKey>(doc)),

    getTokenByHash: async (hash) => {
      const doc = await client.get(await tokenDoc(hash));
      return doc ? entityData<ApiToken>(doc) : null;
    },
    createToken: async (token) => {
      const path = await tokenDoc(token.tokenHash);
      const idMarker = tokenIdMarker(token.id);
      return client.runTransaction(async (tx) => {
        const [existing, marker] = await tx.batchGet([path, idMarker]);
        if (existing) return false;
        if (marker) throw new ConflictError("Token ID exists");
        await tx.commit([
          create(
            path,
            entityFields({ id: token.id, orgId: token.orgId }, token),
          ),
          create(idMarker, markerFields(path)),
        ]);
        return true;
      });
    },
    putToken: async (token) => {
      const path = await tokenDoc(token.tokenHash);
      const idMarker = tokenIdMarker(token.id);
      await client.runTransaction(async (tx) => {
        const [existing, marker] = await tx.batchGet([path, idMarker]);
        if (existing && entityData<ApiToken>(existing).id !== token.id)
          throw new ConflictError("Token exists");
        const writes: Write[] = [];
        const previous = owner(marker);
        if (previous !== undefined && previous !== path)
          writes.push(remove(previous));
        writes.push(
          set(path, entityFields({ id: token.id, orgId: token.orgId }, token)),
          set(idMarker, markerFields(path)),
        );
        await tx.commit(writes);
      });
    },
    listTokens: (orgId, cursor, limit) =>
      pageQuery(client, {
        query: {
          parent: "",
          collection: "tokens",
          where: [
            { field: "orgId", op: "EQUAL", value: { stringValue: orgId } },
          ],
          orderBy: [
            { field: "id", direction: "ASC" },
            { field: NAME_FIELD, direction: "ASC" },
          ],
        },
        scope: JSON.stringify(["tokens", orgId]),
        cursor,
        limit,
        read: (doc) => summarizeApiToken(entityData<ApiToken>(doc)),
      }),
    revokeToken: async (orgId, id, at) =>
      client.runTransaction(async (tx) => {
        const target = owner(await tx.get(tokenIdMarker(id)));
        if (target === undefined) return null;
        const doc = await tx.get(target);
        if (!doc) return null;
        const token = entityData<ApiToken>(doc);
        if (token.orgId !== orgId) return null;
        if (token.revokedAt) return summarizeApiToken(token);
        const revoked = { ...token, revokedAt: at };
        await tx.commit([
          set(
            target,
            entityFields({ id: token.id, orgId: token.orgId }, revoked),
          ),
        ]);
        return summarizeApiToken(revoked);
      }),
  };
}
