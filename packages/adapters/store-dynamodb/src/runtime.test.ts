import { UnsupportedQueryError } from "@errtraq/core/store";
import { describe, expect, it, vi } from "vitest";
import { DynamoTransactionCanceledError } from "./errors.js";
import {
  create,
  DynamoStore,
  DynamoStoreAccessDeniedError,
  DynamoStoreError,
} from "./runtime.js";

const environment = {
  AWS_ACCESS_KEY_ID: "credential-id",
  AWS_SECRET_ACCESS_KEY: "secret-value",
  AWS_SESSION_TOKEN: "session-token",
};
describe("DynamoDB store runtime", () => {
  it("retains transaction cancellation images without exposing them through serialization", async () => {
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment,
      fetch: async () =>
        Response.json(
          {
            __type: "TransactionCanceledException",
            CancellationReasons: [
              {
                Code: "ConditionalCheckFailed",
                Item: { data: { S: "sensitive-event-data" } },
              },
            ],
          },
          { status: 400 },
        ),
    });
    const error = await store
      .request("TransactWriteItems", { ClientRequestToken: "stable-token" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DynamoTransactionCanceledError);
    expect((error as DynamoTransactionCanceledError).reasons).toEqual([
      {
        code: "ConditionalCheckFailed",
        item: { data: { S: "sensitive-event-data" } },
      },
    ]);
    expect(JSON.stringify(error)).not.toContain("sensitive-event-data");
  });
  it("reads the persisted shard count consistently and rejects a mismatch", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          TableName: "table",
          ConsistentRead: true,
          Key: { PK: { S: "META|schema" }, SK: { S: "DATA" } },
        });
        expect(new Headers(init?.headers).get("x-amz-security-token")).toBe(
          "session-token",
        );
        return Response.json({ Item: { projectTimeShards: { N: "3" } } });
      },
    );
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment,
      endpoint: "http://localhost:1234",
      fetch: fetcher,
    });
    await store.migrate();
    expect(store.indexShards).toBe(3);
    const mismatched = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment,
      endpoint: "http://localhost:1234",
      indexShards: 4,
      fetch: fetcher,
    });
    await expect(mismatched.migrate()).rejects.toBeInstanceOf(DynamoStoreError);
  });
  it("reports typed sanitized provider errors", async () => {
    const warn = vi.fn();
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment,
      endpoint: "http://localhost:1234",
      logger: { debug() {}, info() {}, warn, error() {} },
      fetch: async () =>
        Response.json(
          { __type: "AccessDeniedException", message: "secret-value" },
          { status: 403 },
        ),
    });
    const error = await store.migrate().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DynamoStoreAccessDeniedError);
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-value");
  });
  it("looks up a public key in exactly one strongly consistent read", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-amz-target")).toBe(
          "DynamoDB_20120810.GetItem",
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ConsistentRead: true,
          Key: { PK: { S: expect.stringMatching(/^KEY\|/) } },
        });
        return Response.json({});
      },
    );
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment,
      fetch: fetcher,
    });
    expect(await store.projects.getKey("public-key")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not include malformed provider response data in errors", async () => {
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment,
      fetch: async () => new Response("secret-value invalid JSON"),
    });
    const error = await store.migrate().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DynamoStoreError);
    expect(JSON.stringify(error)).not.toContain("secret-value");
  });
  it("validates construction and clearly rejects unavailable ports", async () => {
    expect(() =>
      create({ config: {}, bindings: {}, dependencies: {} }),
    ).toThrow("table binding");
    const store = create({
      config: {},
      bindings: { ERRTRAQ_STORE_TABLE: "table" },
      dependencies: {},
      environment: { AWS_REGION: "us-east-1" },
    });
    await expect(
      store.events.deleteBySubject(
        "p" as never,
        { kind: "eventIds", eventIds: [] },
        "2025-01-01T00:00:00.000Z" as never,
        1,
      ),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(
      store.issues.repairAfterErasure("p" as never, "i" as never, 1),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);
  });
});
