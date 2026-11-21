import { describe, expect, it, vi } from "vitest";
import {
  type AwsEmulatorClient,
  createAwsTestNamespace,
} from "./aws-emulator.js";

describe("AWS emulator namespace", () => {
  it("creates independent names and cleans up in reverse order", async () => {
    const calls: string[] = [];
    const api: AwsEmulatorClient = {
      request: async (_service, path, options) => {
        calls.push(`${options?.method} ${path}`);
      },
      emptyBucket: async (bucket) => {
        calls.push(`empty ${bucket}`);
      },
      dynamo: async (action) => {
        calls.push(action);
        return {};
      },
      sqs: async (action, input) => {
        calls.push(action);
        return action === "CreateQueue"
          ? { QueueUrl: `queue:${input.QueueName}` }
          : {};
      },
    };
    const a = await createAwsTestNamespace(api, {}, {});
    const b = await createAwsTestNamespace(api, {}, {});
    expect(a.table).not.toBe(b.table);
    expect(a.queueUrl).not.toBe(b.queueUrl);
    calls.length = 0;
    await a.close();
    await a.close();
    expect(calls).toEqual([
      "DeleteQueue",
      "DeleteTable",
      `empty ${a.bucket}`,
      `DELETE /${a.bucket}`,
    ]);
    await b.close();
  });
  it("seeds store metadata and the distinct store and KV TTL attributes", async () => {
    const dynamo = vi.fn(async () => ({}));
    const api: AwsEmulatorClient = {
      request: vi.fn(async () => ({})),
      emptyBucket: vi.fn(async () => {}),
      dynamo,
      sqs: async (action, input) =>
        action === "CreateQueue" ? { QueueUrl: String(input.QueueName) } : {},
    };
    const metadata = {
      PK: { S: "META|schema" },
      SK: { S: "DATA" },
      projectTimeShards: { N: "4" },
    };
    const ns = await createAwsTestNamespace(
      api,
      {},
      {},
      undefined,
      {},
      "ttlEpoch",
      "expiresAt",
      metadata,
    );
    expect(dynamo).toHaveBeenCalledWith("PutItem", {
      TableName: ns.table,
      Item: metadata,
    });
    expect(dynamo).toHaveBeenCalledWith("UpdateTimeToLive", {
      TableName: ns.table,
      TimeToLiveSpecification: { Enabled: true, AttributeName: "ttlEpoch" },
    });
    expect(dynamo).toHaveBeenCalledWith("UpdateTimeToLive", {
      TableName: ns.kvTable,
      TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" },
    });
    await ns.close();
  });
  it("cleans up created resources when construction fails", async () => {
    const cleanup = vi.fn(async () => ({}));
    const api: AwsEmulatorClient = {
      request: vi.fn(async () => ({})),
      emptyBucket: vi.fn(async () => {}),
      dynamo: cleanup,
      sqs: async () => {
        throw new Error("queue failed");
      },
    };
    await expect(createAwsTestNamespace(api, {}, {})).rejects.toThrow(
      "queue failed",
    );
    expect(cleanup).toHaveBeenLastCalledWith("DeleteTable", expect.anything());
    expect(api.emptyBucket).toHaveBeenCalledOnce();
  });
});
