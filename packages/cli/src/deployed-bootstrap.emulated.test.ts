import { randomUUID } from "node:crypto";
import { signAwsRequest } from "@moriyoshi/errtraq-aws-signing";
import { bootstrapDeployed, hashApiToken } from "@moriyoshi/errtraq-core";
import { DynamoKV } from "@moriyoshi/errtraq-kv-dynamodb/runtime";
import { DynamoStore } from "@moriyoshi/errtraq-store-dynamodb/runtime";
import { afterEach, describe, expect, it } from "vitest";

const endpoint = process.env.ERRTRAQ_DYNAMO_EMULATOR;
if (
  endpoint &&
  (new URL(endpoint).hostname !== "127.0.0.1" ||
    new URL(endpoint).origin !== endpoint)
)
  throw new Error("DynamoDB emulator must be loopback");
const environment = {
  AWS_ACCESS_KEY_ID: "emulator",
  AWS_SECRET_ACCESS_KEY: "emulator",
};
const tables: string[] = [];
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
    headers: signed.headers,
    body,
  });
  if (!response.ok) throw new Error(`DynamoDB emulator ${action} failed`);
  return response.json();
}
describe.skipIf(!endpoint)("deployed bootstrap on DynamoDB Local", () => {
  afterEach(async () => {
    for (const table of tables.splice(0))
      await api("DeleteTable", { TableName: table });
  });
  it("bootstraps concurrently with the real DynamoDB store and KV adapters", async () => {
    const suffix = randomUUID().replaceAll("-", ""),
      storeTable = `store-${suffix}`,
      kvTable = `kv-${suffix}`;
    const storeShape = JSON.parse(
        process.env.ERRTRAQ_DYNAMO_STORE_SHAPE ?? "{}",
      ),
      kvShape = JSON.parse(process.env.ERRTRAQ_DYNAMO_KV_SHAPE ?? "{}");
    await api("CreateTable", { ...storeShape, TableName: storeTable });
    tables.push(storeTable);
    await api("CreateTable", { ...kvShape, TableName: kvTable });
    tables.push(kvTable);
    await api("PutItem", {
      TableName: storeTable,
      Item: {
        PK: { S: "META|schema" },
        SK: { S: "DATA" },
        projectTimeShards: { N: "4" },
      },
    });
    const store = new DynamoStore({
      table: storeTable,
      region: "us-east-1",
      environment,
      endpoint,
    });
    const kv = new DynamoKV({
      table: kvTable,
      region: "us-east-1",
      environment,
      endpoint,
    });
    let secret: string | undefined;
    const vault = {
      async claim(_name: string, candidate: string) {
        secret ??= candidate;
        return { identifier: "arn:bootstrap", value: secret };
      },
    };
    const options = {
      stackName: "stack",
      store,
      kv,
      vault,
      secretName: "bootstrap",
      ingestUrl: "https://ingest.example/",
      orgSlug: "org",
      projectSlug: "project",
    };
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () => bootstrapDeployed(options)),
      ),
    ).toEqual(Array(4).fill("arn:bootstrap"));
    const saved = JSON.parse(secret ?? "null");
    expect(
      await store.projects.getTokenByHash(await hashApiToken(saved.token)),
    ).toMatchObject({ orgId: saved.orgId });
  }, 30000);
});
