import { randomUUID } from "node:crypto";
import { signAwsRequest } from "@errtraq/aws-signing";
import { activeStoreContract } from "@errtraq/testing";
import { afterEach, describe } from "vitest";
import { DynamoStore } from "./runtime.js";

const endpoint = process.env.ERRTRAQ_DYNAMO_EMULATOR;
if (
  endpoint &&
  (new URL(endpoint).hostname !== "127.0.0.1" ||
    new URL(endpoint).origin !== endpoint)
)
  throw new Error("DynamoDB emulator must be loopback");
const shape: Record<string, unknown> = process.env.ERRTRAQ_DYNAMO_STORE_SHAPE
  ? JSON.parse(process.env.ERRTRAQ_DYNAMO_STORE_SHAPE)
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
  return response.json();
}
const tables: string[] = [];
async function makeStore() {
  const table = `errtraq-${randomUUID().replaceAll("-", "")}`;
  await api("CreateTable", { ...shape, TableName: table });
  tables.push(table);
  await api("PutItem", {
    TableName: table,
    Item: {
      PK: { S: "META|schema" },
      SK: { S: "DATA" },
      projectTimeShards: { N: "4" },
    },
  });
  const store = new DynamoStore({
    table,
    region: "us-east-1",
    environment,
    endpoint,
  });
  await store.migrate();
  return store;
}
describe.skipIf(!endpoint)("DynamoDB store emulator", () => {
  afterEach(async () => {
    for (const table of tables.splice(0))
      await api("DeleteTable", { TableName: table });
  });
  activeStoreContract(makeStore);
});
