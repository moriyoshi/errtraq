import { z } from "zod";
import type { Logger, SecretSource } from "./ports.js";
import type { RateRejectionConfig } from "./rate-rejection.js";

export type PortKind =
  | "platform"
  | "store"
  | "queue"
  | "blob"
  | "archive"
  | "kv"
  | "catalog"
  | "engine";
export type FunctionRole = "ingest" | "api" | "consumer" | "record" | "cron";
export const FUNCTION_ROLES: readonly FunctionRole[] = [
  "ingest",
  "api",
  "consumer",
  "record",
  "cron",
];
/** Logical topics are part of core's contract; later handlers must not acknowledge unknown topics. */
export const TOPICS = [
  "ingest",
  "archive.project",
  "notifications",
  "record",
] as const;
export type RoutedTopic = (typeof TOPICS)[number];
/** Visibility must cover six consumer timeouts, allowing for retries and delays. */
export const QUEUE_VISIBILITY_FACTOR = 6;
export const CRON_JOBS = [
  { name: "staged-recovery", schedule: "*/5 * * * *", role: "cron" },
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
  "aws-credentials",
] as const;
export type EnvironmentFeature = (typeof ENVIRONMENT_FEATURES)[number];
export interface AdapterManifest<C = unknown> {
  id: string;
  kind: PortKind;
  configSchema: z.ZodType<C>;
  capabilities: Record<string, CapabilityValue>;
  runtimes: string[];
  requires: EnvironmentFeature[];
  /** External authorization is supplied by a scoped secret binding. */
  adapterAuthorization?: "secret-binding";
  /** Expected port kind for each named nested selection. */
  childKinds?: Record<string, PortKind>;
}
export interface PlatformManifest<C = unknown> extends AdapterManifest<C> {
  kind: "platform";
  runtime: string;
  compute: "function" | "long-lived";
  /** Maximum stack name length accepted by this platform's infrastructure. */
  maxStackNameLength?: number;
  provides: EnvironmentFeature[];
  authorization: "iam" | "bindings" | "none";
  bindingKinds: Binding["kind"][];
  /** Config reference kinds the platform supplies to runtime; absent means none. */
  configReferenceKinds?: ("env" | "variable")[];
  /** Top-level infrastructure-only config fields may reference variables of the declared type. */
  infrastructureConfigReferences?: Record<string, StackVariableType>;
  /** Exact names or prefixes ending in '*'. */
  reservedBindings: string[];
}
export interface FunctionSettings {
  memoryMb?: number;
  timeoutSec?: number;
  architecture?: "x86_64" | "arm64";
  [key: string]: unknown;
}
export interface PhysicalFunction {
  id: string;
  roles: FunctionRole[];
  settings: FunctionSettings;
}
export interface PlatformConfig {
  roles: FunctionRole[];
  split: FunctionRole[];
  http?: FunctionRole[];
  settings?: Partial<Record<FunctionRole, FunctionSettings>>;
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
  readonly name: "name" | "region" | "tags" | "protection";
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
/** Internal deployment binding: encode a config reference for delivery as a string. */
export interface ConfigBindingRef {
  readonly [REF]: "config-binding";
  readonly source: EnvRef | VariableRef;
}
/** A location supplied by the M2c builder for a physical function. */
/** Build manifest entry; artifact references render the path, with the remaining fields available to build tooling. */
export interface BuildArtifact {
  path: string;
  handler: string;
  runtime: string;
  contentHash: string;
}
export interface ArtifactRef {
  readonly [REF]: "artifact";
  readonly functionId: string;
}
export type InfraRef =
  | OutputRef
  | StackRef
  | EnvRef
  | VariableRef
  | ArtifactRef
  | ConfigBindingRef;
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
export const isArtifactRef = (value: unknown): value is ArtifactRef =>
  hasTag(value, "artifact");
export const isConfigBindingRef = (value: unknown): value is ConfigBindingRef =>
  hasTag(value, "config-binding");
export const configBinding = (
  source: EnvRef | VariableRef,
): ConfigBindingRef => ({ [REF]: "config-binding", source });
export const configReferenceBindingName = (
  source: EnvRef | VariableRef,
): string =>
  `ERRTRAQ_CONFIG_${isVariableRef(source) ? "VAR" : "ENV"}_${source.name}`;
export const isInfraRef = (value: unknown): value is InfraRef =>
  isOutputRef(value) ||
  isStackRef(value) ||
  isEnvRef(value) ||
  isVariableRef(value) ||
  isArtifactRef(value) ||
  isConfigBindingRef(value);
export const artifact = (functionId: string): ArtifactRef => ({
  [REF]: "artifact",
  functionId,
});

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
/** Retain a literal verbatim while telling a Terraform renderer whether it needs escaping. */
export function terraformLiteral(value: string): {
  value: string;
  needsEscaping: boolean;
} {
  return { value, needsEscaping: /[$%]\{/.test(value) };
}
/** Escape Terraform interpolation and directive introducers in a literal string. */
export function escapeTerraformLiteral(value: string): string {
  return value.replace(/[$%]\{/g, (match) => `${match[0]}${match}`);
}
export type StackVariableType =
  | "string"
  | "number"
  | "bool"
  | "string[]"
  | "json";
/** JSON variables are JSON text in Terraform and decoded at each structured use. */
export function terraformVariableType(type: StackVariableType): string {
  return type === "json"
    ? "string"
    : type === "string[]"
      ? "list(string)"
      : type;
}
export type InfraValue =
  | string
  | number
  | boolean
  | null
  | OutputRef
  | StackRef
  | EnvRef
  | VariableRef
  | ArtifactRef
  | ConfigBindingRef
  | InfraValue[]
  | { [key: string]: InfraValue };
export type OutputType =
  | "string"
  | "string[]"
  | "json"
  | "json-document"
  | "secret-ref"
  | { map: OutputType };
export interface ModuleDescriptor {
  provider: string;
  component: string;
  outputs: Record<string, OutputType>;
  /** Names of module inputs allowed to contain sensitive variables. */
  sensitiveInputs?: string[];
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
export interface SecretReadRequirement {
  functionId: string;
  selection: string;
  bindingName: string;
  identifier: InfraValue;
}
export interface TopicRoute {
  physical: string;
  producerBinding?: string;
  grouping?: "none" | "per-key-serial";
}
export interface TopicMapping {
  mode: "shared" | "per-topic";
  routes: Record<Exclude<RoutedTopic, "record">, TopicRoute> &
    Partial<Record<"record", TopicRoute>>;
  settings?: Record<string, QueueTriggerSettings>;
}
export interface QueueTriggerSettings {
  batchSize?: number;
  maxConcurrency?: number;
  visibilityTimeoutSec?: number;
  dlq?: { enabled: boolean; maxReceiveCount?: number };
}
export interface DeploymentFunction extends PhysicalFunction {
  artifact: ArtifactRef;
  http: FunctionRole[];
  envBindings: ScopedBinding[];
  secretBindings: ScopedBinding[];
  platformBindings: ScopedBinding[];
  policies: DerivedGrant[];
  secretReads: SecretReadRequirement[];
}
export type DeploymentTrigger =
  | {
      kind: "queue";
      functionId: string;
      physical: string;
      resource: InfraValue;
      /** Environment binding carrying the runtime event-source identifier. */
      eventSourceBinding?: string;
      topics: RoutedTopic[];
      settings: QueueTriggerSettings;
    }
  | { kind: "cron"; functionId: string; name: string; schedule: string };
export interface DeploymentView {
  functions: DeploymentFunction[];
  triggers: DeploymentTrigger[];
}
export interface InfraDescriptor<C> {
  module: ModuleDescriptor;
  inputs(config: C, deployment: DeploymentView): Record<string, InfraValue>;
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
  recordMode?: "direct" | "grouped";
  rateRejection?: RateRejectionConfig;
  /** Runtime environment supplied by the host; the adapter may read refreshed credentials lazily. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Resolve secret identifiers only when an adapter needs the secret bytes. */
  secretSource?: SecretSource;
  logger?: Logger;
  cronJobs?: readonly string[];
  /** Supplied only to a queue adapter. */
  topics?: Partial<Record<RoutedTopic, TopicRoute>>;
  /** Push event-source identifier to physical queue and the topics it carries. */
  queueConsumers?: readonly {
    eventSource: unknown;
    physical: string;
    topics: readonly RoutedTopic[];
  }[];
}
/** An adapter may release resources when construction fails or the process stops. */
export interface ConstructedAdapter {
  close?(): void | Promise<void>;
}
export interface Adapter<C, B, T> {
  manifest: AdapterManifest<C>;
  create(
    context: CreateContext<C, B>,
  ): (T & ConstructedAdapter) | Promise<T & ConstructedAdapter>;
  infra: InfraDescriptor<C>;
}
export interface AdapterSelection<C = unknown> {
  manifest: AdapterManifest;
  infra: InfraDescriptor<C>;
  runtimeModule: string;
  /** Provider entry override; module.provider still identifies the module family. */
  provider?: string;
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
  /** Production protection is the default; disposable permits resource teardown. */
  protection?: "production" | "disposable";
  /** Defaults to grouped for Lambda with SQS and direct otherwise. */
  recordMode?: "direct" | "grouped";
  /** Stack-wide fixed-window limits; unset limits are disabled. */
  rateRejection?: RateRejectionConfig;
  outputs?: Record<string, OutputRef>;
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
      type: StackVariableType;
      sensitive: boolean;
      /** Non-sensitive default; JSON values are native objects or arrays. */
      default?: InfraValue;
    }
  >;
  platform: PlatformSelection;
  store: AdapterSelection;
  queue: AdapterSelection;
  blob: AdapterSelection;
  archive?: AdapterSelection;
  kv: AdapterSelection;
  features?: { notifications?: boolean };
  requirements?: Record<string, Record<string, CapabilityValue>>;
}
export interface StackValidationIssue {
  path: string;
  message: string;
}
