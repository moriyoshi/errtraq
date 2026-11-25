import { randomUUID } from "node:crypto";
import type {
  IssueId,
  Occurrence,
  ProjectId,
  StoredEvent,
} from "@moriyoshi/errtraq-core";
import { FirestoreRestClient } from "@moriyoshi/errtraq-firestore-rest";
import { activeStoreContract } from "@moriyoshi/errtraq-testing";
import { describe, expect, it } from "vitest";
import { FirestoreStore } from "./runtime.js";

// Opt-in: set ERRTRAQ_FIRESTORE_EMULATOR (or FIRESTORE_EMULATOR_HOST) to host:port of the
// Cloud SDK Firestore emulator. The emulator ignores indexes; coverage is proved offline.
const host =
  process.env.ERRTRAQ_FIRESTORE_EMULATOR ?? process.env.FIRESTORE_EMULATOR_HOST;
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error("Firestore emulator must be loopback host:port");

// Each store gets its own project id so documents never collide between tests.
async function makeStore() {
  const store = new FirestoreStore({
    client: new FirestoreRestClient({
      projectId: `errtraq-${randomUUID().slice(0, 8)}`,
      endpoint: `http://${host}`,
      requestTimeoutMs: 60000,
      transactionTimeoutMs: 120000,
      maxTransactionAttempts: 200,
    }),
  });
  await store.migrate();
  return store;
}

describe.skipIf(!host)("Firestore store emulator", () => {
  activeStoreContract(makeStore);
  it("counts exactly under concurrent recordOccurrence on one issue", async () => {
    const store = await makeStore();
    const project = "1" as ProjectId;
    const issueId = "i1" as IssueId;
    const at = "2024-01-01T00:00:01.000Z" as StoredEvent["receivedAt"];
    const make = (i: number): [Occurrence, StoredEvent] => {
      const eventId = `c${i}` as StoredEvent["eventId"];
      return [
        {
          projectId: project,
          issueId,
          eventId,
          fingerprint: "fp",
          receivedAt: at,
          timestamp: at,
          title: "t",
          culprit: "c",
          level: "error",
          type: "e",
          metadata: {},
        },
        {
          projectId: project,
          eventId,
          issueId,
          timestamp: at,
          receivedAt: at,
          level: "error",
          tags: {},
          payload: {},
        },
      ];
    };
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.recordEvent(...make(i))),
    );
    expect((await store.issues.get(project, issueId))?.count).toBe(50);
  });
});
