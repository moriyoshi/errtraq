import type {
  ArchiveState,
  ErasureRequest,
  MetaRepo,
} from "@moriyoshi/errtraq-core";
import { VersionConflictError } from "@moriyoshi/errtraq-core/store";
import {
  type FirestoreClient,
  NAME_FIELD,
  type Query,
} from "@moriyoshi/errtraq-firestore-rest";
import {
  create,
  entityData,
  entityFields,
  pageQuery,
  segment,
  set,
} from "./base.js";

const archivePath = (projectId: string) => `meta/archive|${segment(projectId)}`;
const erasurePath = (projectId: string, id: string) =>
  `erasures/${segment(projectId)}|${segment(id)}`;

export function metaRepository(client: FirestoreClient): MetaRepo {
  /** Compare-and-set on the stored `version`, as one transaction. */
  async function cas<T extends { version: number }>(
    path: string,
    expected: number | null,
    next: T,
    valid: boolean,
    index: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    await client.runTransaction(async (tx) => {
      const doc = await tx.get(path);
      const current = doc ? entityData<T>(doc).version : null;
      if (current !== expected || !valid)
        throw new VersionConflictError(`${label} version conflict`);
      const fields = entityFields({ version: next.version, ...index }, next);
      await tx.commit([doc ? set(path, fields) : create(path, fields)]);
    });
  }
  return {
    getArchiveState: async (projectId) => {
      const doc = await client.get(archivePath(projectId));
      return doc ? entityData<ArchiveState>(doc) : null;
    },
    compareAndSetArchiveState: (projectId, expected, next) =>
      cas(
        archivePath(projectId),
        expected,
        next,
        next.projectId === projectId &&
          next.version === (expected === null ? 0 : expected + 1),
        { projectId },
        "Archive",
      ),
    getErasureRequest: async (projectId, id) => {
      const doc = await client.get(erasurePath(projectId, id));
      return doc ? entityData<ErasureRequest>(doc) : null;
    },
    listErasureRequests: ({ projectId, state, cursor, limit }) => {
      const where: NonNullable<Query["where"]> = [];
      if (projectId)
        where.push({
          field: "projectId",
          op: "EQUAL",
          value: { stringValue: projectId },
        });
      if (state)
        where.push({
          field: "state",
          op: "EQUAL",
          value: { stringValue: state },
        });
      return pageQuery(client, {
        query: {
          parent: "",
          collection: "erasures",
          where,
          orderBy: [{ field: NAME_FIELD, direction: "ASC" }],
        },
        scope: JSON.stringify(["erasures", projectId ?? null, state ?? null]),
        cursor,
        limit,
        read: entityData<ErasureRequest>,
      });
    },
    compareAndSetErasureRequest: (projectId, id, expected, next) =>
      cas(
        erasurePath(projectId, id),
        expected,
        next,
        next.projectId === projectId &&
          next.id === id &&
          next.version === (expected === null ? 0 : expected + 1),
        { projectId, state: next.state },
        "Erasure",
      ),
  };
}
