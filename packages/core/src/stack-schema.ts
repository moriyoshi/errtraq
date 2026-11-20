import { z } from "zod";
import {
  type AdapterSelection,
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
const refName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const outputType: z.ZodType<OutputType> = z.lazy(() =>
  z.union([
    z.enum(["string", "string[]", "json", "secret-ref"]),
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
});
export const platformSchema = manifestSchema.extend({
  kind: z.literal("platform"),
  runtime: z.string().min(1),
  compute: z.enum(["function", "long-lived"]),
  provides: z.array(z.enum(ENVIRONMENT_FEATURES)),
  authorization: z.enum(["iam", "bindings", "none"]),
  bindingKinds: z.array(z.enum(["env", "secret", "platform"])),
  reservedBindings: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/)),
});
const descriptorSchema = z.strictObject({
  module: z.strictObject({
    provider: name,
    component: name,
    version: z.string().min(1).optional(),
    outputs: z.record(refName, outputType),
  }),
  inputs: z.custom<(config: unknown) => Record<string, InfraValue>>(
    (v) => typeof v === "function",
  ),
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
        }),
      ),
    })
    .optional(),
});
const selectionSchema: z.ZodType<AdapterSelection> = z.lazy(() =>
  z.strictObject({
    manifest: z.union([platformSchema, manifestSchema]),
    infra: descriptorSchema,
    runtimeModule: z.string().min(1),
    config: z.unknown(),
    dependsOn: z.record(name, z.string().min(1)).optional(),
    children: z.record(name, selectionSchema).optional(),
    existing: z.record(refName, infraValue).optional(),
  }),
) as z.ZodType<AdapterSelection>;
export const rootSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  providers: z
    .record(
      name,
      z.strictObject({
        source: z.string().min(1),
        version: z.string().min(1),
        region: z.string().min(1).optional(),
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
      }),
    )
    .optional(),
  platform: selectionSchema,
  store: selectionSchema,
  queue: selectionSchema,
  blob: selectionSchema,
  archive: selectionSchema.optional(),
  kv: selectionSchema,
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
    cron: z.array(z.string()),
  })
  .passthrough();
export const requiredCapabilities: Partial<
  Record<PortKind, Record<string, z.ZodType>>
> = {
  store: {
    textSearch: z.boolean(),
    lastSeenRangeOnOtherSort: z.boolean(),
    deleteStrategy: z.enum(["explicit", "ttl"]),
  },
  queue: {
    delivery: z.enum(["push", "pull", "both"]),
    maxBytes: z.number().positive(),
    delay: z.boolean(),
    dlq: z.boolean(),
  },
  archive: {
    rowDelete: z.enum(["deletion-vector", "position-delete", "copy-on-write"]),
  },
};
