import type { z } from "zod";

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
}
export interface FunctionSettings {
  memoryMb?: number;
  timeoutSec?: number;
  architecture?: "x86_64" | "arm64";
}
export interface PlatformConfig {
  roles: FunctionRole[];
  split: FunctionRole[];
  settings?: Partial<Record<FunctionRole, FunctionSettings>>;
  cron: string[];
}
export interface OutputRef {
  readonly kind: "output";
  readonly selection?: string;
  readonly name: string;
}
export interface StackRef {
  readonly kind: "stack";
  readonly name: "name" | "region" | "tags";
}
export interface EnvRef {
  readonly kind: "env";
  readonly name: string;
  readonly phase: "generate" | "runtime";
}
export interface VariableRef {
  readonly kind: "variable";
  readonly name: string;
}
export const out = (name: string): OutputRef => ({ kind: "output", name });
export const output = (selection: string, name: string): OutputRef => ({
  kind: "output",
  selection,
  name,
});
export const stackValue = (name: StackRef["name"]): StackRef => ({
  kind: "stack",
  name,
});
/** Runtime environment lookup; never read from the generator process. */
export const env = (name: string): EnvRef => ({
  kind: "env",
  name,
  phase: "runtime",
});
export const generationEnv = (name: string): EnvRef => ({
  kind: "env",
  name,
  phase: "generate",
});
export const variable = (name: string): VariableRef => ({
  kind: "variable",
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
export type OutputType = "string" | "string[]" | "json" | "secret-ref";
export interface ModuleDescriptor {
  provider: string;
  component: string;
  version?: string;
  outputs: Record<string, OutputType>;
}
export interface Binding {
  name: string;
  kind: "env" | "secret" | "platform";
  roles: FunctionRole[];
  value: InfraValue;
  platformType?: string;
}
export interface Grant {
  role: FunctionRole;
  capability: string;
  resource: OutputRef;
  policy: OutputRef;
}
export interface TopicRoute {
  physical: string;
  producerBinding?: string;
  producers: FunctionRole[];
  consumer: FunctionRole;
  resource: InfraValue;
}
export interface TopicMapping {
  mode: "shared" | "per-topic";
  routes: Record<CoreTopic, TopicRoute>;
}
export interface InfraDescriptor<C> {
  module: ModuleDescriptor;
  inputs(config: C): Record<string, InfraValue>;
  bindings: Binding[];
  capabilities: Record<string, string>;
  grants: Grant[];
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
  region?: string;
  tags?: Record<string, string>;
  providers?: Record<string, { source: string; version: string }>;
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
