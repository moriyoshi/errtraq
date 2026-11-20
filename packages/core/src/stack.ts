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
function isInfraValue(
  value: unknown,
  seen = new Set<object>(),
): value is InfraValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) valid = value.every((v) => isInfraValue(v, seen));
  else {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "kind"))
      valid =
        (record.kind === "output" || record.kind === "env") &&
        typeof record.name === "string" &&
        record.name.length > 0 &&
        Object.keys(record).length === 2;
    else valid = Object.values(record).every((v) => isInfraValue(v, seen));
  }
  seen.delete(value);
  return valid;
}
const infraValueSchema = z.custom<InfraValue>(
  (value) => isInfraValue(value),
  "Invalid infrastructure value",
);
const manifestSchema = z.strictObject({
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
const infraSchema = z.strictObject({
  module: z.string().min(1),
  inputs: z.custom<(config: unknown) => Record<string, InfraValue>>(
    (value) => typeof value === "function",
  ),
  bindings: z.record(z.string(), infraValueSchema),
  grants: z.array(
    z.strictObject({ role: z.string().min(1), to: z.array(roleSchema) }),
  ),
  triggers: z.array(
    z.strictObject({
      fn: roleSchema,
      source: z.union([
        z.string(),
        z.strictObject({ kind: z.literal("output"), name: z.string().min(1) }),
      ]),
      kind: z.enum(["queue", "cron"]),
    }),
  ),
});
const selectionSchema = z.strictObject({
  manifest: manifestSchema,
  infra: infraSchema,
  runtimeModule: z.string().min(1),
  config: z.unknown(),
  existing: z.record(z.string(), infraValueSchema).optional(),
});
const stackSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
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
const requiredCapabilities: Partial<
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
function containsOutput(value: InfraValue): boolean {
  if (Array.isArray(value)) return value.some(containsOutput);
  if (value && typeof value === "object") {
    if ("kind" in value && value.kind === "output") return true;
    return Object.values(value).some(containsOutput);
  }
  return false;
}

export interface StackValidationIssue {
  path: string;
  message: string;
}

/** Validate synchronously; async or throwing adapter schemas are reported as issues. */
function inspectStack(stack: unknown): {
  issues: StackValidationIssue[];
  resolved?: StackConfig;
} {
  const parsed = stackSchema.safeParse(stack);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
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
  const bindingOwners = new Map<string, string>();
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
    for (const [name, schema] of Object.entries(
      requiredCapabilities[kind as PortKind] ?? {},
    ))
      if (!schema.safeParse(selection.manifest.capabilities[name]).success)
        issues.push({
          path: `${kind}.manifest.capabilities.${name}`,
          message: "Missing or invalid capability",
        });
    try {
      const result = selection.manifest.configSchema.safeParse(
        selection.config,
      );
      if (!result.success)
        for (const issue of result.error.issues)
          issues.push({
            path: [kind, "config", ...issue.path].join("."),
            message: issue.message,
          });
      else {
        selection.config = result.data;
        try {
          const inputs = selection.infra.inputs(result.data);
          if (
            !inputs ||
            typeof inputs !== "object" ||
            Array.isArray(inputs) ||
            !isInfraValue(inputs)
          )
            throw new Error("Expected a plain infrastructure value record");
        } catch (error) {
          issues.push({ path: `${kind}.infra.inputs`, message: String(error) });
        }
      }
    } catch (error) {
      issues.push({
        path: `${kind}.config`,
        message: `Config validation failed: ${String(error)}`,
      });
    }
    for (const name of Object.keys(selection.infra.bindings)) {
      const owner = bindingOwners.get(name);
      if (owner)
        issues.push({
          path: `${kind}.infra.bindings.${name}`,
          message: `Binding already declared by ${owner}`,
        });
      else bindingOwners.set(name, kind);
    }
    for (const [index, grant] of selection.infra.grants.entries())
      for (const role of grant.to)
        if (!platform.functions.includes(role))
          issues.push({
            path: `${kind}.infra.grants.${index}.to`,
            message: `Platform does not deploy ${role}`,
          });
    for (const [index, trigger] of selection.infra.triggers.entries()) {
      const path = `${kind}.infra.triggers.${index}`;
      if (!platform.functions.includes(trigger.fn))
        issues.push({
          path: `${path}.fn`,
          message: `Platform does not deploy ${trigger.fn}`,
        });
      if (
        (trigger.kind === "cron" && typeof trigger.source !== "string") ||
        (trigger.kind === "queue" && trigger.source === "")
      )
        issues.push({
          path: `${path}.source`,
          message: "Invalid trigger source",
        });
      if (selection.existing && typeof trigger.source !== "string") {
        const output = trigger.source.name;
        const binding = Object.entries(selection.infra.bindings).find(
          ([, ref]) =>
            typeof ref === "object" &&
            ref !== null &&
            "kind" in ref &&
            ref.kind === "output" &&
            ref.name === output,
        )?.[0];
        if (!binding || !Object.hasOwn(selection.existing, binding))
          issues.push({
            path: `${path}.source`,
            message: "Existing selection does not supply this output",
          });
      }
    }
    if (selection.existing !== undefined) {
      for (const key of Object.keys(selection.infra.bindings))
        if (!Object.hasOwn(selection.existing, key))
          issues.push({
            path: `${kind}.existing.${key}`,
            message: "Missing required binding",
          });
      for (const [key, ref] of Object.entries(selection.existing)) {
        if (!Object.hasOwn(selection.infra.bindings, key))
          issues.push({
            path: `${kind}.existing.${key}`,
            message: "Unknown binding",
          });
        if (containsOutput(ref))
          issues.push({
            path: `${kind}.existing.${key}`,
            message: "Existing bindings cannot refer to module outputs",
          });
      }
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
  return { issues, resolved: value as StackConfig };
}

export function validateStack(stack: unknown): StackValidationIssue[] {
  return inspectStack(stack).issues;
}

/** Parse adapter configurations, validate compatibility and return a resolved stack. */
export function resolveStack(stack: unknown): StackConfig {
  const result = inspectStack(stack);
  if (result.issues.length || !result.resolved)
    throw new Error(
      `Invalid stack: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  return result.resolved;
}

export function defineStack<T extends StackConfig>(stack: T): T {
  return resolveStack(stack) as T;
}
