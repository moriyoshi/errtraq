import { z } from "zod";

export type PortKind =
  | "platform"
  | "store"
  | "queue"
  | "blob"
  | "archive"
  | "kv"
  | "catalog"
  | "engine";
export type FunctionRole = "ingest" | "api" | "consumer" | "cron";
export const FUNCTION_ROLES: readonly FunctionRole[] = [
  "ingest",
  "api",
  "consumer",
  "cron",
];
/** Logical topics are part of core's contract; later handlers must not acknowledge unknown topics. */
export const TOPICS = ["ingest", "archive.project", "notifications"] as const;
export type CoreTopic = (typeof TOPICS)[number];
export const CRON_JOBS = [
  { name: "archive-planner", schedule: "0 * * * *", role: "cron" },
  { name: "retention", schedule: "15 * * * *", role: "cron" },
  { name: "erasure-worker", schedule: "*/5 * * * *", role: "cron" },
] as const satisfies readonly {
  name: string;
  schedule: string;
  role: FunctionRole;
}[]; // TODO(M4): implement handlers.
export type CapabilityValue = string | number | boolean;
export const ENVIRONMENT_FEATURES = [
  "writable-filesystem",
  "long-lived-process",
  "shared-process-state",
] as const;
export type EnvironmentFeature = (typeof ENVIRONMENT_FEATURES)[number];
export interface AdapterManifest<C = unknown> {
  id: string;
  kind: PortKind;
  configSchema: z.ZodType<C>;
  capabilities: Record<string, CapabilityValue>;
  runtimes: string[];
  requires: EnvironmentFeature[];
}
export interface PlatformManifest<C = unknown> extends AdapterManifest<C> {
  kind: "platform";
  runtime: string;
  compute: "function" | "long-lived";
  provides: EnvironmentFeature[];
  authorization: "iam" | "bindings" | "none";
  bindingKinds: Binding["kind"][];
  /** Exact names or prefixes ending in '*'. */
  reservedBindings: string[];
}
export interface FunctionSettings {
  memoryMb?: number;
  timeoutSec?: number;
  architecture?: "x86_64" | "arm64";
}
export interface PhysicalFunction {
  id: string;
  roles: FunctionRole[];
  settings: FunctionSettings;
}
export interface PlatformConfig {
  roles: FunctionRole[];
  split: FunctionRole[];
  settings?: Partial<Record<FunctionRole, FunctionSettings>>;
  cron: string[];
}
/** In-process reference tag; generators must render references, not JSON-serialize them. */
export const REF = Symbol.for("@errtraq/infra-reference");
export interface OutputRef {
  readonly [REF]: "output";
  readonly selection?: string;
  readonly name: string;
  readonly path?: readonly string[];
}
export interface StackRef {
  readonly [REF]: "stack";
  readonly name: "name" | "region" | "tags";
  readonly provider?: string;
}
export interface EnvRef {
  readonly [REF]: "env";
  readonly name: string;
  readonly phase: "generate" | "runtime";
  readonly defaultValue?: string;
  readonly suffix?: string;
  readonly valueType?: "number";
}
export interface VariableRef {
  readonly [REF]: "variable";
  readonly name: string;
}
export type InfraRef = OutputRef | StackRef | EnvRef | VariableRef;
function hasTag(value: unknown, tag: InfraRef[typeof REF]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    REF in value &&
    value[REF] === tag
  );
}
export const isOutputRef = (value: unknown): value is OutputRef =>
  hasTag(value, "output");
export const isStackRef = (value: unknown): value is StackRef =>
  hasTag(value, "stack");
export const isEnvRef = (value: unknown): value is EnvRef =>
  hasTag(value, "env");
export const isVariableRef = (value: unknown): value is VariableRef =>
  hasTag(value, "variable");
export const isInfraRef = (value: unknown): value is InfraRef =>
  isOutputRef(value) ||
  isStackRef(value) ||
  isEnvRef(value) ||
  isVariableRef(value);

/** Config references resolve from the runtime environment, or from TF_VAR values at runtime. */
export function configReference<T extends z.ZodType>(schema: T) {
  return z.union([
    z.custom<EnvRef | VariableRef>(
      (value) =>
        isVariableRef(value) || (isEnvRef(value) && value.phase === "runtime"),
    ),
    schema,
  ]);
}
export const out = (name: string, ...path: string[]): OutputRef => ({
  [REF]: "output",
  name,
  ...(path.length ? { path } : {}),
});
export const output = (
  selection: string,
  name: string,
  ...path: string[]
): OutputRef => ({
  [REF]: "output",
  selection,
  name,
  ...(path.length ? { path } : {}),
});
export const stackValue = (
  name: StackRef["name"],
  provider?: string,
): StackRef => ({
  [REF]: "stack",
  name,
  ...(provider === undefined ? {} : { provider }),
});
/** Runtime environment lookup; never read from the generator process. */
export const env = (
  name: string,
  options: Pick<EnvRef, "defaultValue" | "suffix" | "valueType"> = {},
): EnvRef => ({
  [REF]: "env",
  name,
  phase: "runtime",
  ...options,
});
export const generationEnv = (name: string): EnvRef => ({
  [REF]: "env",
  name,
  phase: "generate",
});
export const variable = (name: string): VariableRef => ({
  [REF]: "variable",
  name,
});
export type InfraValue =
  | string
  | number
  | boolean
  | null
  | OutputRef
  | StackRef
  | EnvRef
  | VariableRef
  | InfraValue[]
  | { [key: string]: InfraValue };
export type OutputType =
  | "string"
  | "string[]"
  | "json"
  | "secret-ref"
  | { map: OutputType };
export interface ModuleDescriptor {
  provider: string;
  component: string;
  version?: string;
  outputs: Record<string, OutputType>;
}
export interface Binding {
  name: string;
  kind: "env" | "secret" | "platform";
  purpose: string;
  /** Capabilities that need this binding; omitted means all uses of the purpose. */
  capabilities?: string[];
  value: InfraValue;
  platformType?: string;
}
export interface DerivedGrant {
  functionId: string;
  selection: string;
  capability: string;
  purpose: string;
  policyOutput?: OutputRef;
}
export interface ScopedBinding {
  functionId: string;
  selection: string;
  binding: Binding;
}
export interface TopicRoute {
  physical: string;
  producerBinding?: string;
}
export interface TopicMapping {
  mode: "shared" | "per-topic";
  routes: Record<CoreTopic, TopicRoute>;
}
export interface InfraDescriptor<C> {
  module: ModuleDescriptor;
  inputs(config: C): Record<string, InfraValue>;
  bindings: Binding[];
  /** A null policy means the capability needs no IAM policy on this adapter. */
  capabilities: Record<string, Record<string, OutputRef | null>>;
  resources: Record<string, InfraValue>;
  topics?: TopicMapping;
}
export interface CreateContext<
  C = unknown,
  B = Record<string, unknown>,
  D = Record<string, unknown>,
> {
  config: C;
  bindings: B;
  dependencies: D;
  topics: Partial<
    Record<CoreTopic, { physical: string; producerBinding?: string }>
  >;
}
export interface Adapter<C, B, T> {
  manifest: AdapterManifest<C>;
  create(context: CreateContext<C, B>): T | Promise<T>;
  infra: InfraDescriptor<C>;
}
export interface AdapterSelection<C = unknown> {
  manifest: AdapterManifest;
  infra: InfraDescriptor<C>;
  runtimeModule: string;
  config: unknown;
  dependsOn?: Record<string, string>;
  children?: Record<string, AdapterSelection>;
  existing?: Record<string, InfraValue>;
}
export interface PlatformSelection extends AdapterSelection {
  manifest: PlatformManifest;
}
export interface StackConfig {
  name: string;
  providers?: Record<
    string,
    {
      source: string;
      version: string;
      region?: string;
      tags?: Record<string, string>;
    }
  >;
  backend?: { type: string; config: Record<string, InfraValue> };
  variables?: Record<
    string,
    {
      type: "string" | "number" | "bool" | "string[]" | "json";
      sensitive: boolean;
    }
  >;
  platform: PlatformSelection;
  store: AdapterSelection;
  queue: AdapterSelection;
  blob: AdapterSelection;
  archive?: AdapterSelection;
  kv: AdapterSelection;
  requirements?: Record<string, Record<string, CapabilityValue>>;
}
export interface StackValidationIssue {
  path: string;
  message: string;
}
