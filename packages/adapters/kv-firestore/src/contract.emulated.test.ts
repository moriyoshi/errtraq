import { randomUUID } from "node:crypto";
import { FirestoreRestClient } from "@moriyoshi/errtraq-firestore-rest";
import { FakeClock, kvContract } from "@moriyoshi/errtraq-testing";
import { describe } from "vitest";
import { FirestoreKV } from "./runtime.js";

// Opt-in: see the store adapter's emulated test.
const host =
  process.env.ERRTRAQ_FIRESTORE_EMULATOR ?? process.env.FIRESTORE_EMULATOR_HOST;
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error("Firestore emulator must be loopback host:port");
let clock: FakeClock;
function makeKV() {
  clock = new FakeClock("2090-01-01T00:00:00.000Z");
  return new FirestoreKV({
    clock,
    client: new FirestoreRestClient({
      projectId: `errtraq-${randomUUID().slice(0, 8)}`,
      endpoint: `http://${host}`,
      requestTimeoutMs: 60000,
    }),
  });
}
describe.skipIf(!host)("Firestore KV emulator", () => {
  kvContract(makeKV, { advance: (ms) => clock.advance(ms) });
});
