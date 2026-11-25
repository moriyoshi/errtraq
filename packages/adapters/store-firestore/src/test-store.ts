import {
  type FirestoreClient,
  FirestoreRestClient,
  type Query,
  type RawDocument,
  shapeOfQuery,
} from "@moriyoshi/errtraq-firestore-rest";
import {
  FakeFirestore,
  type FakeFirestoreOptions,
} from "@moriyoshi/errtraq-firestore-rest/fake";
import { compositeIndexes } from "./indexes.js";
import { FirestoreStore } from "./runtime.js";

export interface Harness {
  store: FirestoreStore;
  fake: FakeFirestore;
  client: FirestoreRestClient;
  queries: Query[];
}
/** A store over the in-process Firestore fake, with declared indexes enforced. */
export function makeFakeStore(
  options: FakeFirestoreOptions = {},
  attempts = 400,
): Harness {
  const fake = new FakeFirestore({ indexes: compositeIndexes, ...options });
  const client = new FirestoreRestClient({
    projectId: "test",
    endpoint: "http://127.0.0.1:1",
    fetch: fake.fetch,
    maxTransactionAttempts: attempts,
    sleep: () => new Promise((r) => setTimeout(r, Math.random() * 2)),
  });
  const queries: Query[] = [];
  client.onQuery = (q) => queries.push(q);
  return { store: new FirestoreStore({ client }), fake, client, queries };
}
export type { FirestoreClient, RawDocument };
export { shapeOfQuery };
