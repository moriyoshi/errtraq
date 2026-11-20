import {
  type AdapterManifest,
  type AdapterSelection,
  type InfraDescriptor,
  out,
  stackValue,
} from "@errtraq/core";
import { z } from "zod";

export const configSchema = z.strictObject({});
export type Config = z.input<typeof configSchema>;
export const manifest: AdapterManifest = {
  id: "kv-dynamodb",
  kind: "kv",
  configSchema,
  runtimes: ["node"],
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
      policies: { map: { map: "string" } },
    },
  },
  inputs: () => ({
    name: stackValue("name"),
    region: stackValue("region"),
    tags: stackValue("tags"),
    purpose: "kv",
  }),
  resources: { primary: out("table_arn") },
  capabilities: {
    read: { primary: out("policies", "read", "primary") },
    write: { primary: out("policies", "write", "primary") },
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
  return { manifest, infra, config, runtimeModule: "@errtraq/kv-dynamodb" };
}
