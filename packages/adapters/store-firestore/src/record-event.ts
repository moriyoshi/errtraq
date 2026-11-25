import type {
  ActiveStore,
  Issue,
  Occurrence,
  RecordInput,
  RecordResult,
  StoredEvent,
} from "@moriyoshi/errtraq-core";
import type { FirestoreClient, Write } from "@moriyoshi/errtraq-firestore-rest";
import { encodeFields } from "@moriyoshi/errtraq-firestore-rest";
import { create, entityData, set } from "./base.js";
import { eventFields, eventPath } from "./events.js";
import { issueFields, issuePath, issuePointerPath } from "./issues.js";

function checkGroup(group: readonly RecordInput[]): void {
  if (!Array.isArray(group) || group.length < 1 || group.length > 10)
    throw new RangeError("Record group must contain 1 to 10 events");
  const first = group[0]?.occurrence;
  if (!first) throw new TypeError("Missing record group");
  for (const { occurrence, event } of group) {
    if (
      occurrence.projectId !== first.projectId ||
      occurrence.issueId !== first.issueId ||
      occurrence.fingerprint !== first.fingerprint ||
      occurrence.projectId !== event.projectId ||
      occurrence.issueId !== event.issueId ||
      occurrence.eventId !== event.eventId ||
      occurrence.receivedAt !== event.receivedAt
    )
      throw new TypeError("Record group identity mismatch");
    // Plain JSON only: reject values the documents could not hold before any request.
    JSON.stringify(occurrence);
    JSON.stringify(event);
  }
}

function newIssue(o: Occurrence): Issue {
  return {
    id: o.issueId,
    projectId: o.projectId,
    fingerprint: o.fingerprint,
    status: "unresolved",
    title: o.title,
    culprit: o.culprit,
    level: o.level,
    type: o.type,
    metadata: structuredClone(o.metadata),
    firstSeen: o.receivedAt,
    lastSeen: o.receivedAt,
    count: 0,
    lastEventId: o.eventId,
    lastEventReceivedAt: o.receivedAt,
  };
}

/**
 * One transaction per group: read the issue and every event document (so concurrent writers of
 * the issue serialize or abort and retry), skip events that exist, create the new ones and
 * update or create the issue (plus its pointer). Atomicity of recordOccurrence is exactly this
 * transaction; idempotency on (projectId, eventId) is the event-document existence check.
 */
async function recordGroupInTransaction(
  client: FirestoreClient,
  group: readonly RecordInput[],
): Promise<RecordResult[]> {
  checkGroup(group);
  const first = (group[0] as RecordInput).occurrence;
  const { projectId, issueId } = first;
  // Encode every event up front: an oversized document fails before the transaction starts.
  const encoded = new Map<string, Awaited<ReturnType<typeof eventFields>>>();
  for (const { event } of group)
    if (!encoded.has(event.eventId))
      encoded.set(event.eventId, await eventFields(event));
  const eventIds = [...encoded.keys()];
  const pathOfIssue = issuePath(projectId, issueId);

  return client.runTransaction(async (tx) => {
    const [issueDoc, ...eventDocs] = await tx.batchGet([
      pathOfIssue,
      ...eventIds.map((id) => eventPath(projectId, id)),
    ]);
    const stored = new Map<string, StoredEvent>();
    eventIds.forEach((id, i) => {
      const doc = eventDocs[i];
      if (doc) stored.set(id, entityData<StoredEvent>(doc) as StoredEvent);
    });
    let issue: Issue | undefined = issueDoc
      ? entityData<Issue>(issueDoc)
      : undefined;
    const created = issue === undefined;
    const writes: Write[] = [];
    const seen = new Set<string>(stored.keys());
    const other = new Map<string, Issue>();
    // An event already stored under another issue is a duplicate of that issue.
    for (const [, event] of stored)
      if (event.issueId !== issueId && !other.has(event.issueId)) {
        const doc = await tx.get(issuePath(projectId, event.issueId));
        if (!doc) throw new Error("Stored event has no issue");
        other.set(event.issueId, entityData<Issue>(doc));
      }
    const results: RecordResult[] = [];
    let inserted = 0;
    for (const { occurrence, event } of group) {
      const existing = stored.get(event.eventId);
      if (seen.has(event.eventId)) {
        const owner =
          existing && existing.issueId !== issueId
            ? other.get(existing.issueId)
            : issue;
        if (!owner) throw new Error("Stored event has no issue");
        results.push({
          inserted: false,
          issue: structuredClone(owner),
          isNew: false,
          isRegression: false,
        });
        continue;
      }
      seen.add(event.eventId);
      if (issue && issue.id !== occurrence.issueId)
        throw new Error("Issue ID does not match fingerprint");
      if (issue && issue.fingerprint !== occurrence.fingerprint)
        throw new Error("Issue ID does not match fingerprint");
      const isNew = issue === undefined;
      const current: Issue = issue
        ? structuredClone(issue)
        : newIssue(occurrence);
      const isRegression =
        current.status === "resolved" &&
        (!current.resolvedAt || occurrence.receivedAt > current.resolvedAt);
      current.count++;
      if (occurrence.receivedAt < current.firstSeen)
        current.firstSeen = occurrence.receivedAt;
      if (
        occurrence.receivedAt > current.lastSeen ||
        (occurrence.receivedAt === current.lastSeen &&
          occurrence.eventId > current.lastEventId)
      ) {
        current.lastSeen = occurrence.receivedAt;
        current.lastEventReceivedAt = occurrence.receivedAt;
        current.lastEventId = occurrence.eventId;
      }
      if (isRegression) {
        current.status = "unresolved";
        delete current.resolvedAt;
      }
      issue = current;
      inserted++;
      writes.push(
        create(
          eventPath(projectId, event.eventId),
          encoded.get(event.eventId) as NonNullable<
            ReturnType<typeof encoded.get>
          >,
        ),
      );
      results.push({
        inserted: true,
        issue: structuredClone(current),
        isNew,
        isRegression,
      });
    }
    if (inserted === 0 || !issue) return results;
    writes.push(
      created
        ? create(pathOfIssue, issueFields(issue))
        : set(pathOfIssue, issueFields(issue)),
    );
    if (created)
      writes.push(
        set(
          issuePointerPath(projectId, issueId),
          encodeFields({ issueId, projectId }),
        ),
      );
    await tx.commit(writes);
    const final = issue;
    return results.map((result) =>
      result.issue.projectId === projectId && result.issue.id === issueId
        ? { ...result, issue: structuredClone(final) }
        : result,
    );
  });
}

/**
 * In-process writers of one issue run one after another. Firestore transactions lock
 * pessimistically: N concurrent read-then-write transactions on one document all take the read
 * lock and then deadlock on the upgrade until the server's lock timeout aborts them (observed on
 * the emulator: a 40-way burst never finished). Queueing per issue within a process removes that
 * self-inflicted contention; transactions still arbitrate between processes.
 */
const tails = new WeakMap<FirestoreClient, Map<string, Promise<unknown>>>();
function recordGroup(
  client: FirestoreClient,
  group: readonly RecordInput[],
): Promise<RecordResult[]> {
  const first = group[0]?.occurrence;
  if (!first || !Array.isArray(group))
    return recordGroupInTransaction(client, group); // rejects with the validation error
  const queues = tails.get(client) ?? new Map<string, Promise<unknown>>();
  tails.set(client, queues);
  const key = `${first.projectId}/${first.issueId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(() => recordGroupInTransaction(client, group));
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export function recordEvent(
  client: FirestoreClient,
): ActiveStore["recordEvent"] {
  return async (occurrence, event) => {
    if (
      occurrence.projectId !== event.projectId ||
      occurrence.eventId !== event.eventId ||
      occurrence.issueId !== event.issueId ||
      occurrence.receivedAt !== event.receivedAt
    )
      throw new Error("Occurrence and event mismatch");
    const [result] = await recordGroup(client, [{ occurrence, event }]);
    if (!result) throw new Error("Record produced no result");
    return result;
  };
}
export function recordEvents(
  client: FirestoreClient,
): ActiveStore["recordEvents"] {
  return (group) => recordGroup(client, group);
}
