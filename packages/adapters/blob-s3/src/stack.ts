import {
  type AdapterManifest,
  type AdapterSelection,
  type InfraDescriptor,
  out,
  stackValue,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";

/** SQS retains messages for at most 14 days; claim checks must outlive any redrive. */
export const MIN_RECORD_CLAIM_RETENTION_DAYS = 15;
export const configSchema = z.strictObject({
  region: z.string().min(1).optional(),
  endpoint: z.url().optional(),
  forcePathStyle: z.boolean().optional(),
  requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
  overallTimeoutMs: z.number().int().min(1).max(300000).optional(),
  bodyIdleTimeoutMs: z.number().int().min(1).max(300000).optional(),
  /**
   * Days before grouped-record claim checks (`payloads/records/`) expire. It must exceed SQS's
   * 14-day maximum message retention; a message redriven after expiry fails as poison and lands
   * in the DLQ.
   */
  recordClaimRetentionDays: z
    .number()
    .int()
    .min(MIN_RECORD_CLAIM_RETENTION_DAYS)
    .max(3650)
    .optional(),
  /**
   * The longest per-project event retention in the stack. Projects must not be configured with a
   * longer retention: orphaned overflow payloads expire after this plus the margin.
   */
  maxEventRetentionDays: z.number().int().min(1).max(3650).optional(),
  /** Days added to `maxEventRetentionDays` before orphaned overflow payloads expire. */
  overflowOrphanMarginDays: z.number().int().min(1).max(3650).optional(),
});
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
      policies: { map: { map: "json-document" } },
    },
  },
  inputs: (config) => ({
    record_claim_retention_days: config.recordClaimRetentionDays ?? 30,
    max_event_retention_days: config.maxEventRetentionDays ?? 30,
    overflow_orphan_margin_days: config.overflowOrphanMarginDays ?? 7,
    name: stackValue("name"),
    protection: stackValue("protection"),
    tags: stackValue("tags"),
  }),
  resources: { primary: out("bucket_arn") },
  capabilities: {
    read: { primary: out("policies", "read", "primary") },
    write: { primary: out("policies", "write", "primary") },
    delete: { primary: out("policies", "delete", "primary") },
    list: { primary: out("policies", "list", "primary") },
  },
  bindings: [
    {
      name: "ERRTRAQ_BLOB_BUCKET",
      kind: "env",
      purpose: "primary",
      value: out("bucket_name"),
    },
  ],
};
export function s3Blob(config: Config = {}): AdapterSelection<Config> {
  return {
    manifest,
    infra,
    config,
    runtimeModule: "@moriyoshi/errtraq-blob-s3/runtime",
  };
}
