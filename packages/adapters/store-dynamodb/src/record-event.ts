import type {
  ActiveStore,
  Issue,
  Occurrence,
  StoredEvent,
} from "@moriyoshi/errtraq-core";
import { DynamoStoreError, DynamoTransactionCanceledError } from "./errors.js";
import { issueFromItem, issueMutableAttributes } from "./issue-item.js";
import { issueKey, issuePointerKey, issuePointerSort } from "./issues.js";
import {
  component,
  eventTimeSort,
  issueCountSort,
  issueTimeSort,
  partition,
  sortKey,
} from "./keys.js";
import {
  assertItemSize,
  contentionDelay,
  type Driver,
  dataItem,
  get,
  type Item,
  itemData,
  itemSize,
  primary,
  s,
} from "./repository-base.js";

export const eventKey = (project: string, id: string) =>
  partition("EV", project, id);
export const issueStatusPartition = (project: string, status: string) =>
  partition("ISSUE", project, status);
export function issueAttributes(issue: Issue): Item {
  const group = issueStatusPartition(issue.projectId, issue.status);
  return {
    GSI3PK: s(partition("ISSUEID", issue.id)),
    GSI3SK: s(sortKey(issue.projectId)),
    GSI4PK: s(group),
    GSI4SK: s(issueTimeSort(issue.lastSeen, issue.id)),
    GSI5PK: s(group),
    GSI5SK: s(issueTimeSort(issue.firstSeen, issue.id)),
    GSI6PK: s(group),
    GSI6SK: s(issueCountSort(issue.count, issue.id)),
  };
}
async function eventShard(id: string, shards: number) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
  );
  return ((hash[0] ?? 0) % shards).toString();
}
async function eventItem(event: StoredEvent, shards: number) {
  const value: Item = {
    ...dataItem(eventKey(event.projectId, event.eventId), event),
    GSI1PK: s(
      partition(
        "EVENTPROJECT",
        event.projectId,
        await eventShard(event.eventId, shards),
      ),
    ),
    GSI1SK: s(eventTimeSort(event.receivedAt, event.eventId)),
    GSI2PK: s(partition("EVENTISSUE", event.projectId, event.issueId)),
    GSI2SK: s(eventTimeSort(event.receivedAt, event.eventId)),
  };
  assertItemSize(value);
  return value;
}
function nextIssue(occ: Occurrence, previous: Issue | null) {
  if (
    previous &&
    (previous.id !== occ.issueId || previous.fingerprint !== occ.fingerprint)
  )
    throw new Error("Issue identity does not match fingerprint");
  const isNew = !previous;
  const regression =
    previous?.status === "resolved" &&
    (!previous.resolvedAt || occ.receivedAt > previous.resolvedAt);
  const issue: Issue = previous
    ? { ...previous }
    : {
        id: occ.issueId,
        projectId: occ.projectId,
        fingerprint: occ.fingerprint,
        status: "unresolved",
        title: occ.title,
        culprit: occ.culprit,
        level: occ.level,
        type: occ.type,
        metadata: occ.metadata,
        firstSeen: occ.receivedAt,
        lastSeen: occ.receivedAt,
        count: 0,
        lastEventId: occ.eventId,
        lastEventReceivedAt: occ.receivedAt,
      };
  if (
    !Number.isSafeInteger(issue.count) ||
    issue.count < 0 ||
    issue.count === Number.MAX_SAFE_INTEGER
  )
    throw new RangeError("Invalid issue count");
  issue.count++;
  if (occ.receivedAt < issue.firstSeen) issue.firstSeen = occ.receivedAt;
  if (
    occ.receivedAt > issue.lastSeen ||
    (occ.receivedAt === issue.lastSeen &&
      component(occ.eventId) > component(issue.lastEventId))
  ) {
    issue.lastSeen = occ.receivedAt;
    issue.lastEventReceivedAt = occ.receivedAt;
    issue.lastEventId = occ.eventId;
  }
  if (regression) {
    issue.status = "unresolved";
    delete issue.resolvedAt;
  }
  return { issue, isNew, isRegression: !!regression };
}
export function recordEvent(
  d: Driver,
  shards: () => number | Promise<number>,
): ActiveStore["recordEvent"] {
  return async (occ, event) => {
    if (
      occ.projectId !== event.projectId ||
      occ.issueId !== event.issueId ||
      occ.eventId !== event.eventId ||
      occ.receivedAt !== event.receivedAt
    )
      throw new Error("Occurrence and event mismatch");
    const count = await shards();
    const PK = issueKey(occ.projectId, occ.issueId),
      evPK = eventKey(event.projectId, event.eventId);
    const eventRow = await eventItem(event, count);
    let old = await get(d, PK);
    for (let attempt = 0; attempt < 80; attempt++) {
      const previous = issueFromItem(old),
        next = nextIssue(occ, previous),
        attrs = issueAttributes(next.issue);
      const candidate = {
        ...primary(PK),
        data: s(JSON.stringify(next.issue)),
        count: { N: String(next.issue.count) },
        ...attrs,
        ...issueMutableAttributes(next.issue),
      };
      assertItemSize(candidate);
      const legacy = !!previous && !old?.issueStatus?.S;
      const names: Record<string, string> = { "#count": "count" };
      const values: Record<string, unknown> = { ":one": { N: "1" } };
      const updates: Item = {};
      if (!previous || legacy) {
        Object.assign(updates, attrs, issueMutableAttributes(next.issue));
        updates.data = candidate.data;
      } else {
        updates.GSI6SK = attrs.GSI6SK;
        if (next.issue.firstSeen !== previous.firstSeen) {
          updates.firstSeen = s(next.issue.firstSeen);
          updates.GSI5SK = attrs.GSI5SK;
        }
        if (
          next.issue.lastSeen !== previous.lastSeen ||
          next.issue.lastEventId !== previous.lastEventId
        ) {
          updates.lastSeen = s(next.issue.lastSeen);
          updates.lastEventId = s(next.issue.lastEventId);
          updates.lastEventReceivedAt = s(next.issue.lastEventReceivedAt);
          updates.GSI4SK = attrs.GSI4SK;
        }
        if (next.isRegression) {
          updates.issueStatus = s("unresolved");
          updates.GSI4PK = attrs.GSI4PK;
          updates.GSI5PK = attrs.GSI5PK;
          updates.GSI6PK = attrs.GSI6PK;
        }
      }
      const sets: string[] = [];
      for (const [name, value] of Object.entries(updates)) {
        names[`#${name}`] = name;
        values[`:${name}`] = value;
        sets.push(`#${name} = :${name}`);
      }
      let condition = "attribute_not_exists(PK)";
      if (previous) {
        values[":oldCount"] = { N: String(previous.count) };
        if (legacy) {
          names["#oldData"] = "data";
          values[":oldData"] = old?.data;
          condition = "#count = :oldCount AND #oldData = :oldData";
        } else {
          names["#status"] = "issueStatus";
          names["#resolved"] = "resolvedAt";
          values[":resolved"] = s("resolved");
          values[":received"] = s(occ.receivedAt);
          condition = next.isRegression
            ? "#count = :oldCount AND #status = :resolved AND (attribute_not_exists(#resolved) OR #resolved < :received)"
            : "#count = :oldCount AND (#status <> :resolved OR #resolved >= :received)";
        }
      }
      if (next.isRegression && !legacy) names["#removeResolved"] = "resolvedAt";
      const updateExpression = `SET ${sets.join(", ")}${next.isRegression && !legacy ? " REMOVE #removeResolved" : ""} ADD #count :one`;
      const writes: object[] = [
        {
          Put: {
            TableName: d.table,
            Item: eventRow,
            ConditionExpression: "attribute_not_exists(PK)",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
        {
          Update: {
            TableName: d.table,
            Key: primary(PK),
            UpdateExpression: updateExpression,
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
      ];
      if (next.isNew)
        writes.push({
          Put: {
            TableName: d.table,
            Item: {
              ...primary(
                issuePointerKey(occ.issueId),
                issuePointerSort(occ.projectId),
              ),
              owner: s(PK),
            },
            ConditionExpression: "attribute_not_exists(PK)",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        });
      try {
        await d.request("TransactWriteItems", {
          TransactItems: writes,
          ClientRequestToken: crypto.randomUUID(),
        });
        const saved = issueFromItem(await get(d, PK));
        if (!saved) throw new Error("Committed issue is missing");
        return {
          inserted: true,
          issue: saved,
          isNew: next.isNew,
          isRegression: next.isRegression,
        };
      } catch (error) {
        if (!(error instanceof DynamoTransactionCanceledError)) throw error;
        const reasons = error.reasons;
        const unexpected = reasons.find(
          ({ code }) =>
            code &&
            ![
              "None",
              "ConditionalCheckFailed",
              "TransactionConflict",
              "ProvisionedThroughputExceeded",
              "ThrottlingError",
            ].includes(code),
        );
        if (unexpected?.code)
          throw new DynamoStoreError(
            "DynamoDB transaction rejected",
            unexpected.code,
          );
        if (reasons[0]?.code === "ConditionalCheckFailed" || !reasons.length) {
          const duplicate = itemData<StoredEvent>(
            (reasons[0]?.item as Item | undefined) ?? (await get(d, evPK)),
          );
          if (duplicate) {
            const issue = issueFromItem(
              await get(d, issueKey(duplicate.projectId, duplicate.issueId)),
            );
            if (!issue) throw new Error("Stored event has no issue");
            return {
              inserted: false,
              issue,
              isNew: false,
              isRegression: false,
            };
          }
        }
        old = (reasons[1]?.item as Item | undefined) ?? (await get(d, PK));
        if (reasons[2]?.code === "ConditionalCheckFailed" && !old)
          throw new DynamoStoreError("Issue pointer already exists");
        if (attempt < 79) await contentionDelay(attempt);
      }
    }
    throw new DynamoStoreError(
      "DynamoDB transaction contention limit reached",
      "TransactionConflict",
      true,
    );
  };
}

/** One atomic issue update and one conditional put per distinct new event. */
export function recordEvents(
  d: Driver,
  shards: () => number | Promise<number>,
): ActiveStore["recordEvents"] {
  return async (group) => {
    if (!Array.isArray(group) || group.length < 1 || group.length > 10)
      throw new RangeError("Record group must contain 1 to 10 events");
    const first = group[0];
    if (!first) throw new TypeError("Missing record group");
    const { occurrence: firstOcc } = first;
    for (const { occurrence: o, event: e } of group) {
      if (
        o.projectId !== firstOcc.projectId ||
        o.issueId !== firstOcc.issueId ||
        o.fingerprint !== firstOcc.fingerprint ||
        o.projectId !== e.projectId ||
        o.issueId !== e.issueId ||
        o.eventId !== e.eventId ||
        o.receivedAt !== e.receivedAt
      )
        throw new TypeError("Record group identity mismatch");
    }
    const count = await shards();
    const unique = new Map<
      string,
      { occurrence: Occurrence; event: StoredEvent; row: Item; index: number }
    >();
    for (const [index, { occurrence, event }] of group.entries()) {
      if (!unique.has(event.eventId))
        unique.set(event.eventId, {
          occurrence,
          event,
          row: await eventItem(event, count),
          index,
        });
    }
    const keys = [...unique.values()];
    const PK = issueKey(firstOcc.projectId, firstOcc.issueId);
    const duplicates = new Map<string, StoredEvent>();
    let old = await get(d, PK);
    for (let attempt = 0; attempt < 80; attempt++) {
      const pending = keys.filter(
        ({ event }) => !duplicates.has(event.eventId),
      );
      const previous = issueFromItem(old);
      let current = previous;
      const flags = new Map<
        string,
        { isNew: boolean; isRegression: boolean }
      >();
      for (const entry of pending) {
        const next = nextIssue(entry.occurrence, current);
        flags.set(entry.event.eventId, {
          isNew: next.isNew,
          isRegression: next.isRegression,
        });
        current = next.issue;
      }
      if (pending.length && current) {
        const attrs = issueAttributes(current);
        const candidate = {
          ...primary(PK),
          data: s(JSON.stringify(current)),
          count: { N: String(current.count) },
          ...attrs,
          ...issueMutableAttributes(current),
        };
        assertItemSize(candidate);
        const issueSize = itemSize({
          ...candidate,
          ...(old?.issueStatus?.S && old.data ? { data: old.data } : {}),
        });
        const pointerSize = previous
          ? 0
          : itemSize({
              ...primary(
                issuePointerKey(firstOcc.issueId),
                issuePointerSort(firstOcc.projectId),
              ),
              owner: s(PK),
            });
        if (
          pending.reduce(
            (sum, entry) => sum + itemSize(entry.row),
            issueSize + pointerSize,
          ) >
          4 * 1024 * 1024
        )
          throw new RangeError("DynamoDB transaction exceeds 4 MiB");
        const legacy = !!previous && !old?.issueStatus?.S;
        const names: Record<string, string> = { "#count": "count" };
        const values: Record<string, unknown> = {
          ":increment": { N: String(pending.length) },
        };
        const updates: Item =
          previous && !legacy
            ? { ...attrs, ...issueMutableAttributes(current) }
            : {
                ...attrs,
                ...issueMutableAttributes(current),
                data: candidate.data,
              };
        const sets: string[] = [];
        for (const [name, value] of Object.entries(updates)) {
          names[`#${name}`] = name;
          values[`:${name}`] = value;
          sets.push(`#${name} = :${name}`);
        }
        let condition = "attribute_not_exists(PK)";
        if (previous) {
          values[":oldCount"] = { N: String(previous.count) };
          if (legacy) {
            names["#oldData"] = "data";
            values[":oldData"] = old?.data;
            condition = "#count = :oldCount AND #oldData = :oldData";
          } else {
            names["#oldStatus"] = "issueStatus";
            names["#oldResolved"] = "resolvedAt";
            values[":oldStatus"] = s(previous.status);
            condition = "#count = :oldCount AND #oldStatus = :oldStatus AND ";
            if (previous.resolvedAt) {
              values[":oldResolved"] = s(previous.resolvedAt);
              condition += "#oldResolved = :oldResolved";
            } else condition += "attribute_not_exists(#oldResolved)";
          }
        }
        let remove = "";
        if (!current.resolvedAt && previous?.resolvedAt && !legacy) {
          names["#removedResolved"] = "resolvedAt";
          remove = " REMOVE #removedResolved";
        }
        const writes: object[] = pending.map(({ row }) => ({
          Put: {
            TableName: d.table,
            Item: row,
            ConditionExpression: "attribute_not_exists(PK)",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        }));
        const issueIndex = writes.length;
        writes.push({
          Update: {
            TableName: d.table,
            Key: primary(PK),
            UpdateExpression: `SET ${sets.join(", ")}${remove} ADD #count :increment`,
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        });
        if (!previous)
          writes.push({
            Put: {
              TableName: d.table,
              Item: {
                ...primary(
                  issuePointerKey(firstOcc.issueId),
                  issuePointerSort(firstOcc.projectId),
                ),
                owner: s(PK),
              },
              ConditionExpression: "attribute_not_exists(PK)",
              ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            },
          });
        try {
          await d.request("TransactWriteItems", {
            TransactItems: writes,
            ClientRequestToken: crypto.randomUUID(),
          });
          const saved = issueFromItem(await get(d, PK));
          if (!saved) throw new Error("Committed issue is missing");
          const seen = new Set<string>();
          const result: import("@moriyoshi/errtraq-core").RecordResult[] = [];
          for (const { event } of group) {
            const duplicate = duplicates.get(event.eventId);
            let issue = saved;
            if (duplicate && duplicate.issueId !== saved.id) {
              const found = issueFromItem(
                await get(d, issueKey(duplicate.projectId, duplicate.issueId)),
              );
              if (!found) throw new Error("Stored event has no issue");
              issue = found;
            }
            const inserted = !duplicate && !seen.has(event.eventId);
            const flag = flags.get(event.eventId);
            result.push({
              inserted,
              issue,
              isNew: inserted && !!flag?.isNew,
              isRegression: inserted && !!flag?.isRegression,
            });
            seen.add(event.eventId);
          }
          return result;
        } catch (error) {
          if (!(error instanceof DynamoTransactionCanceledError)) throw error;
          for (const [index, entry] of pending.entries()) {
            if (
              error.reasons[index]?.code === "ConditionalCheckFailed" ||
              !error.reasons.length
            ) {
              const item =
                (error.reasons[index]?.item as Item | undefined) ??
                (await get(
                  d,
                  eventKey(entry.event.projectId, entry.event.eventId),
                ));
              const saved = itemData<StoredEvent>(item);
              if (saved) duplicates.set(entry.event.eventId, saved);
            }
          }
          const unexpected = error.reasons.find(
            ({ code }) =>
              code &&
              ![
                "None",
                "ConditionalCheckFailed",
                "TransactionConflict",
                "ProvisionedThroughputExceeded",
                "ThrottlingError",
              ].includes(code),
          );
          if (unexpected?.code)
            throw new DynamoStoreError(
              "DynamoDB transaction rejected",
              unexpected.code,
            );
          old =
            (error.reasons[issueIndex]?.item as Item | undefined) ??
            (await get(d, PK));
          if (attempt < 79) await contentionDelay(attempt);
        }
      } else {
        const results: import("@moriyoshi/errtraq-core").RecordResult[] = [];
        for (const { event } of group) {
          const duplicate = duplicates.get(event.eventId);
          if (!duplicate) throw new Error("Missing duplicate event");
          const issue = issueFromItem(
            await get(d, issueKey(duplicate.projectId, duplicate.issueId)),
          );
          if (!issue) throw new Error("Stored event has no issue");
          results.push({
            inserted: false,
            issue,
            isNew: false,
            isRegression: false,
          });
        }
        return results;
      }
    }
    throw new DynamoStoreError(
      "DynamoDB transaction contention limit reached",
      "TransactionConflict",
      true,
    );
  };
}
