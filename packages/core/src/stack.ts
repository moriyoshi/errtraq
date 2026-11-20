import { z } from "zod";

export type PortKind =
  | "platform"
  | "store"
  | "queue"
  | "blob"
  | "archive"
  | "kv";

export type FunctionRole = "ingest" | "api" | "consumer" | "cron";

export type CapabilityValue = string | number | boolean;

export interface AdapterManifest<C = unknown> {
  id: string;
  kind: PortKind;
  configSchema: z.ZodType<C>;
  capabilities: Record<string, CapabilityValue>;
  runtimes: string[];
}

export interface PlatformManifest<C = unknown> extends AdapterManifest<C> {
  kind: "platform";
  runtime: string;
  compute: "function" | "long-lived";
  functions: FunctionRole[];
}

export interface OutputRef {
  readonly kind: "output";
  readonly name: string;
}

export interface EnvRef {
  readonly kind: "env";
  readonly name: string;
}

export function out(name: string): OutputRef {
  return { kind: "output", name };
}

export function env(name: string): EnvRef {
  return { kind: "env", name };
}

export type InfraValue =
  | string
  | number
  | boolean
  | null
  | OutputRef
  | EnvRef
  | InfraValue[]
  | { [key: string]: InfraValue };

export interface InfraDescriptor<C> {
  module: string;
  inputs(config: C): Record<string, InfraValue>;
  bindings: Record<string, InfraValue>;
  grants: Array<{ role: string; to: FunctionRole[] }>;
  triggers: Array<{
    fn: FunctionRole;
    source: OutputRef | string;
    kind: "queue" | "cron";
  }>;
}

export interface Adapter<C, B, T> {
  manifest: AdapterManifest<C>;
  create(config: C, bindings: B): T | Promise<T>;
  infra: InfraDescriptor<C>;
}

/** Config and descriptor are carried together; selection does not import runtime code. */
export interface AdapterSelection<C = unknown> {
  manifest: AdapterManifest;
  infra: InfraDescriptor<C>;
  runtimeModule: string;
  config: unknown;
  existing?: Record<string, InfraValue>;
}

export interface PlatformSelection extends AdapterSelection {
  manifest: PlatformManifest;
}

export interface StackConfig {
  name: string;
  platform: PlatformSelection;
  store: AdapterSelection;
  queue: AdapterSelection;
  blob: AdapterSelection;
  archive?: AdapterSelection;
  kv: AdapterSelection;
  requirements?: Partial<
    Record<Exclude<PortKind, "platform">, Record<string, CapabilityValue>>
  >;
}

const valueSchema = z.union([z.string(), z.number(), z.boolean()]);
const roleSchema = z.enum(["ingest", "api", "consumer", "cron"]);
const infraValueSchema: z.ZodType<InfraValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(infraValueSchema),
    z.record(z.string(), infraValueSchema),
  ]),
);
const manifestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["platform", "store", "queue", "blob", "archive", "kv"]),
  configSchema: z.custom<z.ZodType>((v) => v instanceof z.ZodType),
  capabilities: z.record(z.string(), valueSchema),
  runtimes: z.array(z.string().min(1)).min(1),
});
const platformManifestSchema = manifestSchema.extend({
  kind: z.literal("platform"),
  runtime: z.string().min(1),
  compute: z.enum(["function", "long-lived"]),
  functions: z.array(roleSchema),
});
const infraSchema = z.object({
  module: z.string().min(1),
  inputs: z.custom<(config: unknown) => Record<string, InfraValue>>(
    (value) => typeof value === "function",
  ),
  bindings: z.record(z.string(), infraValueSchema),
  grants: z.array(
    z.object({ role: z.string().min(1), to: z.array(roleSchema) }),
  ),
  triggers: z.array(
    z.object({
      fn: roleSchema,
      source: z.union([
        z.string(),
        z.object({ kind: z.literal("output"), name: z.string().min(1) }),
      ]),
      kind: z.enum(["queue", "cron"]),
    }),
  ),
});
const selectionSchema = z.object({
  manifest: manifestSchema,
  infra: infraSchema,
  runtimeModule: z.string().min(1),
  config: z.unknown(),
  existing: z.record(z.string(), infraValueSchema).optional(),
});
const stackSchema = z.object({
  name: z.string().min(1),
  platform: selectionSchema.extend({ manifest: platformManifestSchema }),
  store: selectionSchema,
  queue: selectionSchema,
  blob: selectionSchema,
  archive: selectionSchema.optional(),
  kv: selectionSchema,
  requirements: z
    .partialRecord(
      z.enum(["store", "queue", "blob", "archive", "kv"]),
      z.record(z.string(), valueSchema),
    )
    .optional(),
});

export interface StackValidationIssue {
  path: string;
  message: string;
}

/** Validates structure, adapter configuration, and cross-adapter compatibility. */
export function validateStack(stack: unknown): StackValidationIssue[] {
  const parsed = stackSchema.safeParse(stack);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
  const value = parsed.data;
  const issues: StackValidationIssue[] = [];
  const platform = value.platform.manifest;
  const selections = {
    platform: value.platform,
    store: value.store,
    queue: value.queue,
    blob: value.blob,
    archive: value.archive,
    kv: value.kv,
  };
  for (const [kind, selection] of Object.entries(selections)) {
    if (!selection) continue;
    if (selection.manifest.kind !== kind)
      issues.push({
        path: kind,
        message: `Expected ${kind} adapter, got ${selection.manifest.kind}`,
      });
    if (!selection.manifest.runtimes.includes(platform.runtime))
      issues.push({
        path: kind,
        message: `Adapter ${selection.manifest.id} does not support runtime ${platform.runtime}`,
      });
    const result = selection.manifest.configSchema.safeParse(selection.config);
    if (!result.success)
      for (const issue of result.error.issues)
        issues.push({
          path: [kind, "config", ...issue.path].join("."),
          message: issue.message,
        });
    for (const [index, grant] of selection.infra.grants.entries())
      for (const role of grant.to)
        if (!platform.functions.includes(role))
          issues.push({
            path: `${kind}.infra.grants.${index}.to`,
            message: `Platform does not deploy ${role}`,
          });
    for (const [index, trigger] of selection.infra.triggers.entries())
      if (!platform.functions.includes(trigger.fn))
        issues.push({
          path: `${kind}.infra.triggers.${index}.fn`,
          message: `Platform does not deploy ${trigger.fn}`,
        });
    if (selection.existing !== undefined) {
      const expected = Object.keys(selection.infra.bindings);
      const actual = Object.keys(selection.existing);
      for (const key of expected)
        if (!Object.hasOwn(selection.existing, key))
          issues.push({
            path: `${kind}.existing.${key}`,
            message: "Missing required binding",
          });
      for (const key of actual)
        if (!Object.hasOwn(selection.infra.bindings, key))
          issues.push({
            path: `${kind}.existing.${key}`,
            message: "Unknown binding",
          });
    }
  }
  if (
    value.queue.manifest.capabilities.delivery === "pull" &&
    platform.compute === "function"
  )
    issues.push({
      path: "queue",
      message: "Pull-only queues require long-lived compute",
    });
  for (const [kind, required] of Object.entries(value.requirements ?? {})) {
    const selected = selections[kind as keyof typeof selections];
    for (const [capability, expected] of Object.entries(required))
      if (!selected || selected.manifest.capabilities[capability] !== expected)
        issues.push({
          path: `${kind}.capabilities.${capability}`,
          message: `Requires ${String(expected)}`,
        });
  }
  return issues;
}

export function defineStack<T extends StackConfig>(stack: T): T {
  const issues = validateStack(stack);
  if (issues.length)
    throw new Error(
      `Invalid stack: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  return stack;
}
