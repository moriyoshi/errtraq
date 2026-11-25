import type { Issue, IssueRepo } from "@moriyoshi/errtraq-core";
import {
  NotFoundError,
  UnsupportedQueryError,
} from "@moriyoshi/errtraq-core/store";
import {
  type FirestoreClient,
  NAME_FIELD,
  type Query,
} from "@moriyoshi/errtraq-firestore-rest";
import { entityData, entityFields, pageQuery, segment, set } from "./base.js";

export const issuePath = (projectId: string, issueId: string) =>
  `projects/${segment(projectId)}/issues/${segment(issueId)}`;
/** Strong cross-project lookup: one pointer per (project, issue), created with the issue. */
export const issuePointerPath = (projectId: string, issueId: string) =>
  `issueIds/${segment(projectId)}|${segment(issueId)}`;
export const issueFields = (issue: Issue) =>
  entityFields(
    {
      status: issue.status,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      count: issue.count,
    },
    issue,
  );

export function issueRepository(client: FirestoreClient): IssueRepo {
  return {
    getById: async (issueId) => {
      const pointers = await client.runQuery({
        parent: "",
        collection: "issueIds",
        where: [
          { field: "issueId", op: "EQUAL", value: { stringValue: issueId } },
        ],
        limit: 100,
      });
      const docs = await client.batchGet(
        pointers.map((p) => {
          const projectId = p.fields.projectId;
          if (!projectId || !("stringValue" in projectId))
            throw new Error("Invalid issue pointer");
          return issuePath(projectId.stringValue, issueId);
        }),
      );
      return docs.flatMap((doc) => (doc ? [entityData<Issue>(doc)] : []));
    },
    get: async (projectId, issueId) => {
      const doc = await client.get(issuePath(projectId, issueId));
      return doc ? entityData<Issue>(doc) : null;
    },
    list: async (q) => {
      if (q.text !== undefined)
        throw new UnsupportedQueryError("Text search is not supported");
      if ((q.from || q.to) && q.sort !== "lastSeen")
        throw new UnsupportedQueryError(
          "A lastSeen range requires the lastSeen sort on this store",
        );
      const where: NonNullable<Query["where"]> = [];
      if (q.status)
        where.push({
          field: "status",
          op: "EQUAL",
          value: { stringValue: q.status },
        });
      if (q.from)
        where.push({
          field: "lastSeen",
          op: "GREATER_THAN_OR_EQUAL",
          value: { stringValue: q.from },
        });
      if (q.to)
        where.push({
          field: "lastSeen",
          op: "LESS_THAN",
          value: { stringValue: q.to },
        });
      return pageQuery(client, {
        query: {
          parent: `projects/${segment(q.projectId)}`,
          collection: "issues",
          where,
          // Descending sort value with ascending issue ID as the tie break (explicit, so the
          // order matches the other stores).
          orderBy: [
            { field: q.sort, direction: "DESC" },
            { field: NAME_FIELD, direction: "ASC" },
          ],
        },
        scope: JSON.stringify([
          "issues",
          q.projectId,
          q.sort,
          q.status ?? null,
          q.from ?? null,
          q.to ?? null,
        ]),
        cursor: q.cursor,
        limit: q.limit,
        read: entityData<Issue>,
      });
    },
    repairAfterErasure: async () => {
      throw new UnsupportedQueryError(
        "Subject erasure is unavailable until M4",
      );
    },
    update: async (projectId, issueId, patch) =>
      client.runTransaction(async (tx) => {
        const path = issuePath(projectId, issueId);
        const doc = await tx.get(path);
        if (!doc) throw new NotFoundError("Issue not found");
        const issue = entityData<Issue>(doc);
        const next: Issue = { ...issue };
        if ("status" in patch && patch.status !== undefined)
          next.status = patch.status;
        if ("resolvedAt" in patch) {
          if (patch.resolvedAt === undefined) delete next.resolvedAt;
          else next.resolvedAt = patch.resolvedAt;
        }
        await tx.commit([set(path, issueFields(next))]);
        return next;
      }),
  };
}
