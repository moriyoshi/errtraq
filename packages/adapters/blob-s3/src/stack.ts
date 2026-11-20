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
  id: "blob-s3",
  kind: "blob",
  configSchema,
  runtimes: ["node", "workers"],
  requires: [],
  capabilities: {},
};
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "aws",
    component: "s3",
    outputs: {
      bucket_name: "string",
      bucket_arn: "string",
      staging_arn: "string",
      policies: { map: { map: "json-document" } },
    },
  },
  inputs: () => ({
    name: stackValue("name"),
    region: stackValue("region"),
    tags: stackValue("tags"),
    staging_prefix: "archive-staging/",
  }),
  resources: { primary: out("bucket_arn"), staging: out("staging_arn") },
  capabilities: {
    read: {
      primary: out("policies", "read", "primary"),
      staging: out("policies", "read", "staging"),
    },
    write: {
      primary: out("policies", "write", "primary"),
      staging: out("policies", "write", "staging"),
    },
    delete: {
      primary: out("policies", "delete", "primary"),
      staging: out("policies", "delete", "staging"),
    },
    list: {
      primary: out("policies", "list", "primary"),
      staging: out("policies", "list", "staging"),
    },
  },
  bindings: [
    {
      name: "ERRTRAQ_BLOB_BUCKET",
      kind: "env",
      purpose: "primary",
      value: out("bucket_name"),
    },
    {
      name: "ERRTRAQ_STAGING_BUCKET",
      kind: "env",
      purpose: "staging",
      value: out("bucket_name"),
    },
    {
      name: "ERRTRAQ_STAGING_PREFIX",
      kind: "env",
      purpose: "staging",
      value: "archive-staging/",
    },
  ],
};
export function s3Blob(config: Config = {}): AdapterSelection<Config> {
  return { manifest, infra, config, runtimeModule: "@errtraq/blob-s3" };
}
