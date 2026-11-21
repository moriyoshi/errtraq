import { randomUUID } from "node:crypto";
import { signAwsRequest } from "@errtraq/aws-signing";
import { FakeClock, kvContract } from "@errtraq/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DynamoKV } from "./runtime.js";

const endpoint = process.env.ERRTRAQ_DYNAMO_EMULATOR;
if (
  endpoint &&
  (new URL(endpoint).hostname !== "127.0.0.1" ||
    new URL(endpoint).origin !== endpoint)
)
  throw new Error("DynamoDB emulator must be loopback");
const shape = process.env.ERRTRAQ_DYNAMO_KV_SHAPE
  ? JSON.parse(process.env.ERRTRAQ_DYNAMO_KV_SHAPE)
  : {};
const environment = {
  AWS_ACCESS_KEY_ID: "emulator",
  AWS_SECRET_ACCESS_KEY: "emulator",
};
async function api(action: string, input: Record<string, unknown>) {
  if (!endpoint) throw new Error("Missing emulator");
  const body = JSON.stringify(input);
  const signed = await signAwsRequest({
    url: `${endpoint}/`,
    method: "POST",
    body,
    service: "dynamodb",
    region: "us-east-1",
    accessKeyId: environment.AWS_ACCESS_KEY_ID,
    secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": `DynamoDB_20120810.${action}`,
    },
  });
  const response = await fetch(signed.url, {
    method: "POST",
    body,
    headers: signed.headers,
  });
  if (!response.ok)
    throw new Error(`Emulator ${action} failed: ${await response.text()}`);
  return await response.json();
}
const tables: string[] = [];
let clock: FakeClock;
async function makeKV() {
  const table = `errtraq-${randomUUID().replaceAll("-", "")}`;
  await api("CreateTable", { ...shape, TableName: table });
  tables.push(table);
  await api("UpdateTimeToLive", {
    TableName: table,
    TimeToLiveSpecification: {
      Enabled: true,
      AttributeName: process.env.ERRTRAQ_DYNAMO_TTL_ATTRIBUTE,
    },
  });
  clock = new FakeClock("2090-01-01T00:00:00.000Z");
  return new DynamoKV({
    table,
    region: "us-east-1",
    environment,
    endpoint,
    clock,
  });
}
describe.skipIf(!endpoint)("DynamoDB KV emulator", () => {
  afterEach(async () => {
    for (const TableName of tables.splice(0))
      await api("DeleteTable", { TableName });
  });
  kvContract(makeKV, { advance: (ms) => clock.advance(ms) });
  it("recreates expired counters and preserves the initial TTL", async () => {
    const kv = await makeKV();
    expect(await kv.increment("counter", 2, { ttlSec: 10 })).toBe(2);
    clock.advance(5000);
    expect(await kv.increment("counter", 3, { ttlSec: 100 })).toBe(5);
    clock.advance(5000);
    expect(await kv.get("counter")).toBeNull();
    const raw = await api("GetItem", {
      TableName: tables.at(-1),
      Key: { PK: { S: "KV#counter" }, SK: { S: "KV" } },
      ConsistentRead: true,
    });
    expect(raw.Item).toBeDefined(); // The logical clock expired it while the future-dated row remains physically present.
    expect(await kv.increment("counter", 7, { ttlSec: 20 })).toBe(7);
    clock.advance(19999);
    expect(await kv.get("counter")).toBe("7");
    clock.advance(1);
    expect(await kv.get("counter")).toBeNull();
  });
  it("does not add a TTL to an existing permanent counter", async () => {
    const kv = await makeKV();
    await kv.put("permanent", "0005");
    expect(await kv.increment("permanent", 1, { ttlSec: 1 })).toBe(6);
    clock.advance(2000);
    expect(await kv.get("permanent")).toBe("6");
  });
});
