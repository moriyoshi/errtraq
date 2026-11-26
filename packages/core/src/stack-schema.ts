import { z } from "zod";
import { RATE_REJECTION_BOUNDS } from "./rate-rejection.js";
import {
  type AdapterSelection,
  type DeploymentView,
  ENVIRONMENT_FEATURES,
  FUNCTION_ROLES,
  type InfraValue,
  isOutputRef,
  type OutputType,
  type PortKind,
  REF,
} from "./stack-model.js";

const role = z.enum(FUNCTION_ROLES);
const name = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const refName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((value) => value !== "__proto__", "Reserved identifier __proto__");
const outputType: z.ZodType<OutputType> = z.lazy(() =>
  z.union([
    z.enum(["string", "string[]", "json", "json-document", "secret-ref"]),
    z.strictObject({ map: outputType }),
  ]),
);
const infraValue: z.ZodType<InfraValue> = z.lazy(() =>
  z.union([
    z.custom<InfraValue>(
      (value) => typeof value === "object" && value !== null && REF in value,
    ),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(infraValue),
    z.record(z.string(), infraValue),
  ]),
) as z.ZodType<InfraValue>;
const manifestSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([
    "platform",
    "store",
    "queue",
    "blob",
    "archive",
    "kv",
    "catalog",
    "engine",
  ]),
  configSchema: z.custom<z.ZodType>((v) => v instanceof z.ZodType),
  capabilities: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
  runtimes: z.array(z.string().min(1)).min(1),
  requires: z.array(z.enum(ENVIRONMENT_FEATURES)),
  adapterAuthorization: z.literal("secret-binding").optional(),
  childKinds: z
    .record(
      name,
      z.enum([
        "platform",
        "store",
        "queue",
        "blob",
        "archive",
        "kv",
        "catalog",
        "engine",
      ]),
    )
    .optional(),
});
export const platformSchema = manifestSchema.extend({
  kind: z.literal("platform"),
  runtime: z.string().min(1),
  maxStackNameLength: z.number().int().positive().optional(),
  compute: z.enum(["function", "long-lived"]),
  provides: z.array(z.enum(ENVIRONMENT_FEATURES)),
  authorization: z.enum(["iam", "bindings", "none"]),
  bindingKinds: z.array(z.enum(["env", "secret", "platform"])),
  configReferenceKinds: z.array(z.enum(["env", "variable"])).optional(),
  infrastructureConfigReferences: z
    // Dotted paths name a field of a nested setting, e.g. `oidc.issuer`.
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/),
      z.enum(["string", "number", "bool", "string[]", "json"]),
    )
    .optional(),
  reservedBindings: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/)),
  groupedRecordQueues: z.array(z.string().min(1)).optional(),
  minQueueDlqAttempts: z.number().int().positive().optional(),
  deliversConfigBindings: z.boolean().optional(),
  deliversIngestRateLimit: z.boolean().optional(),
  supportsArchive: z.boolean().optional(),
});
const descriptorSchema = z.strictObject({
  module: z.strictObject({
    provider: name,
    component: name,
    sensitiveInputs: z.array(refName).optional(),
    outputs: z.record(refName, outputType),
  }),
  inputs: z.custom<
    (config: unknown, deployment: DeploymentView) => Record<string, InfraValue>
  >((v) => typeof v === "function"),
  bindings: z.array(
    z.strictObject({
      name: refName,
      kind: z.enum(["env", "secret", "platform"]),
      purpose: name,
      capabilities: z.array(name).min(1).optional(),
      value: infraValue,
      platformType: z.string().min(1).optional(),
    }),
  ),
  capabilities: z.record(
    name,
    z.record(name, z.union([z.custom(isOutputRef), z.null()])),
  ),
  resources: z.record(name, infraValue),
  topics: z
    .strictObject({
      mode: z.enum(["shared", "per-topic"]),
      routes: z.record(
        z.string(),
        z.strictObject({
          physical: name,
          producerBinding: refName.optional(),
          grouping: z.enum(["none", "per-key-serial"]).optional(),
        }),
      ),
      settings: z
        .record(
          name,
          z.strictObject({
            batchSize: z.number().int().positive().optional(),
            maxConcurrency: z.number().int().positive().optional(),
            visibilityTimeoutSec: z.number().int().positive().optional(),
            retryBackoffSec: z
              .strictObject({
                min: z.number().int().min(0),
                max: z.number().int().min(0),
              })
              .refine((value) => value.min <= value.max)
              .optional(),
            dlq: z
              .strictObject({
                enabled: z.boolean(),
                maxReceiveCount: z.number().int().positive().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
const selectionSchema: z.ZodType<AdapterSelection> = z.lazy(() =>
  z.strictObject({
    manifest: z.union([platformSchema, manifestSchema]),
    infra: descriptorSchema,
    runtimeModule: z.string().min(1),
    provider: name.optional(),
    config: z.unknown(),
    dependsOn: z.record(name, z.string().min(1)).optional(),
    children: z.record(name, selectionSchema).optional(),
    existing: z.record(refName, infraValue).optional(),
  }),
) as z.ZodType<AdapterSelection>;
export const rootSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  protection: z.enum(["production", "disposable"]).default("production"),
  recordMode: z.enum(["direct", "grouped"]).optional(),
  archiveRetentionDays: z.number().int().min(1).max(36500).optional(),
  rateRejection: z
    .strictObject({
      issueRateLimit: z
        .strictObject({
          events: z.number().int().min(1).max(RATE_REJECTION_BOUNDS.maxCount),
          windowSec: z
            .number()
            .int()
            .min(RATE_REJECTION_BOUNDS.minWindowSec)
            .max(RATE_REJECTION_BOUNDS.maxWindowSec),
        })
        .optional(),
      newIssueCap: z
        .strictObject({
          issues: z.number().int().min(1).max(RATE_REJECTION_BOUNDS.maxCount),
          windowSec: z
            .number()
            .int()
            .min(RATE_REJECTION_BOUNDS.minWindowSec)
            .max(RATE_REJECTION_BOUNDS.maxWindowSec),
        })
        .optional(),
      onKvFailure: z.enum(["allow", "retry"]).default("allow"),
    })
    .optional(),
  outputs: z.record(refName, z.custom(isOutputRef)).optional(),
  providers: z
    .record(
      name,
      z.strictObject({
        source: z.string().min(1),
        version: z.string().min(1),
        region: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  backend: z
    .strictObject({ type: name, config: z.record(z.string(), infraValue) })
    .optional(),
  variables: z
    .record(
      refName,
      z.strictObject({
        type: z.enum(["string", "number", "bool", "string[]", "json"]),
        sensitive: z.boolean(),
        default: infraValue.optional(),
      }),
    )
    .optional(),
  platform: selectionSchema,
  store: selectionSchema,
  queue: selectionSchema,
  blob: selectionSchema,
  archive: selectionSchema.optional(),
  kv: selectionSchema,
  features: z
    .strictObject({ notifications: z.boolean().optional() })
    .optional(),
  requirements: z
    .record(
      z.string(),
      z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    )
    .optional(),
});
export const platformConfigSchema = z
  .object({
    roles: z.array(role).min(1),
    split: z.array(role),
    http: z.array(role).optional(),
    cron: z.never().optional(),
    settings: z
      .partialRecord(
        role,
        z
          .object({
            // Broad portable sanity limits; a platform schema may impose stricter limits.
            memoryMb: z.number().int().min(128).max(1048576).optional(),
            timeoutSec: z.number().int().min(1).max(86400).optional(),
            architecture: z.enum(["x86_64", "arm64"]).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export const requiredCapabilities: Partial<
  Record<PortKind, Record<string, z.ZodType>>
> = {
  store: {
    textSearch: z.boolean(),
    recordEvents: z.boolean(),
    lastSeenRangeOnOtherSort: z.boolean(),
    deleteStrategy: z.enum(["explicit", "ttl"]),
  },
  queue: {
    delivery: z.enum(["push", "pull", "both"]),
    grouping: z.enum(["none", "per-key-serial"]),
    maxBytes: z.number().positive(),
    delay: z.boolean(),
    dlq: z.boolean(),
    visibilityTimeout: z.boolean(),
  },
  archive: {
    rowDelete: z.enum(["deletion-vector", "position-delete", "copy-on-write"]),
  },
};
