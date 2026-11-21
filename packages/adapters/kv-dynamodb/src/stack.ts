import {
  type AdapterManifest,
  type AdapterSelection,
  type InfraDescriptor,
  out,
  stackValue,
} from "@errtraq/core";
import { z } from "zod";

export const configSchema = z.strictObject({
  region: z.string().min(1).optional(),
  endpoint: z.url().optional(),
  requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
  overallTimeoutMs: z.number().int().min(1).max(300000).optional(),
});
export type Config = z.input<typeof configSchema>;
export const manifest: AdapterManifest = {
  id: "kv-dynamodb",
  kind: "kv",
  configSchema,
  runtimes: ["node", "workers"],
  requires: [],
  capabilities: {},
};
/** HCL module contract; policies are module outputs, not provider IAM in TypeScript. */
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "aws",
    component: "dynamodb",
    outputs: {
      table_name: "string",
      table_arn: "string",
      policies: { map: { map: "json-document" } },
    },
  },
  inputs: () => ({
    name: stackValue("name"),
    protection: stackValue("protection"),
    tags: stackValue("tags"),
    purpose: "kv",
  }),
  resources: { primary: out("table_arn") },
  capabilities: {
    read: { primary: out("policies", "read", "primary") },
    write: { primary: out("policies", "write", "primary") },
    delete: { primary: out("policies", "delete", "primary") },
  },
  bindings: [
    {
      name: "ERRTRAQ_KV_TABLE",
      kind: "env",
      purpose: "primary",
      value: out("table_name"),
    },
  ],
};
export function dynamoKv(config: Config = {}): AdapterSelection<Config> {
  return {
    manifest,
    infra,
    config,
    runtimeModule: "@errtraq/kv-dynamodb/runtime",
  };
}
