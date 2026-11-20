# Infrastructure model

This document describes the implemented M2a2 model in `packages/core/src/stack-*.ts` and the
local runtime. Terraform generation, real AWS descriptors and modules, and static entrypoints
are M2b / M2c work. The example descriptors below are test fixtures, not production adapters.

## Selections and descriptors

A `StackConfig` names a platform, store, queue, blob, KV and optional archive, along with
providers, variables, backend, optional output references and optional capability requirements.
A selection contains a manifest, `config`, a `runtimeModule`, an `infra` descriptor, optional
runtime `dependsOn` aliases, optional `children`, and optional `existing` substitutions. Parent
manifests declare `childKinds` for every child alias; a platform cannot be a child. The module
address is `moduleName(path)`, replacing dots by underscores. Validation rejects collisions.
Selection, purpose and physical keys use lowercase identifiers (`[a-z][a-z0-9_-]*`); output
names and binding names use `[A-Za-z_][A-Za-z0-9_]*`. The logical topic `archive.project` is
therefore distinct from an identifier such as `archive_project`.

A descriptor provides `module` (provider, component, output types and optional
`sensitiveInputs`), `inputs(config, deployment)`, `resources`, `capabilities`, `bindings`, and
for queues `topics`. The second argument is available to every descriptor and is the frozen
`DeploymentView`; platform inputs use it to wire compute. A resource maps a purpose / physical
key to an `InfraValue`. A capability maps each purpose to its own `OutputRef` policy or `null`
when no IAM policy is needed. Bindings name their resource purpose and may limit themselves to
specific capabilities; they do not list function roles. `module.outputs` supports `string`,
`string[]`, `json`, `secret-ref`, and recursive `{ map: OutputType }`. `out("queues", key,
"arn")` selects a key path within the current selection; `output("queue", "queues", key,
"arn")` names another selection. Map keys are identifiers. The generator must render references
rather than JSON-serialize them.

The intended HCL source for a module is `infra/modules/<provider>/<component>`; the future
generator must resolve it relative to its generated root. `module.version` was removed: provider
version constraints live in stack provider entries, while module resources live in HCL.

Manifests declare runtime compatibility and required environment features. Store capabilities
include text search, range support and delete strategy; queue capabilities include delivery,
size, delay, DLQ and `visibilityTimeout`. Platform manifests declare `runtime`, `compute`,
`authorization` (`iam`, `bindings`, or `none`), supported `bindingKinds`, reserved exact names
or prefix patterns ending in `*`, and provided environment features. Adapter `requires` and
platform `provides` use `writable-filesystem`, `long-lived-process`, and
`shared-process-state`. The last requires a declared guarantee and one long-lived physical
function. `none` authorization likewise requires one long-lived physical function. IAM requires
policy outputs for every required capability and purpose; binding authorization requires a
platform producer binding for active queue routes. Environment bindings must be scalar strings.
The module provider named `local` does not require provider metadata; other modules do.

The model validates reference types and policy output placement, but it does **not** inspect a
policy document or module input to prove that it contains no raw provider IAM or that its policy
is least privilege. An adapter author and the future HCL module must provide that guarantee.

## Reference phases and literals

All reference objects use the global `Symbol.for("@errtraq/infra-reference")` tag and the
exported guards (`isOutputRef`, `isStackRef`, `isEnvRef`, `isVariableRef`, `isArtifactRef`,
`isInfraRef`). They are in-process values, not JSON data. They must be rendered explicitly:

| Constructor | Resolution |
|---|---|
| `out(name, ...keys)`, `output(selection, name, ...keys)` | Terraform module output expression, or an `existing` substitution. |
| `stackValue("name")` | Generation-time stack name. |
| `stackValue("region" / "tags", provider?)` | Generation-time provider value. Without a provider, use the owning selection's module provider. |
| `variable(name)` | Declared Terraform variable; CLI runtime reads `TF_VAR_<name>`. |
| `env(name, options?)` | Runtime environment lookup; optional string default and suffix, and optional numeric conversion. |
| `generationEnv(name)` | Generation-time lookup, currently valid only in backend config. The future generator must read it and fail if absent. |
| `artifact(functionId)` | Build-time artifact location, valid only in platform module inputs; M2c supplies it. |

`configReference(schema)` permits that schema's literal values, runtime `env` or `variable`
references. Validation rejects output, stack, artifact and generation-time references in adapter
config even if an adapter schema accepts arbitrary values. The CLI resolves config references
before `create`; individual adapters may then validate their runtime input. A resolved stack is
branded and its copied data objects are deeply frozen, so core does not re-run transforming
adapter schemas. Shared Zod schema instances and executable functions remain unfrozen; Zod uses
lazy initialization. Do not mutate them after resolving.

A `json` output or variable represents a native object or array, not an encoded JSON string or a
scalar. `TF_VAR_` values enter as strings and the CLI parses JSON into that native value, rejecting
scalars. `terraformVariableType("json")` returns `any`; M2b must emit a Terraform validation
that requires an object or array as well. `string[]` maps to `list(string)`. This differs from a
JSON policy document serialized as text: an existing `json` output must be supplied as native data.
Capability policy outputs may use `json` for native documents or `string` for serialized documents;
the AWS modules use `string` because IAM policy inputs expect JSON text. Core checks the declared
type, not whether a string contains a valid provider policy.

Literal strings may contain Terraform template introducers. `terraformLiteral(s)` returns
`{ value: s, needsEscaping }` without changing the data; `escapeTerraformLiteral(s)` escapes
both `${` and `%{`. M2b must apply this to every literal string it renders, including nested
values, and must not escape expressions rendered from reference objects. These helpers do not
perform generation themselves.

Providers are keyed entries with `source`, `version`, optional `region` and `tags`; provider keys
also act as qualifiers. The entry named `aws` requires a region. Backend values may be literals
or `generationEnv`, not Terraform variables or module/runtime references. There is currently no
separate stack-metadata environment-reference field. Sensitive variables are rejected everywhere
except module inputs whose top-level names appear in `module.sensitiveInputs`; their handling by
Terraform and the provider module still matters for state. A secret binding instead carries a
non-sensitive string variable identifying an existing secret or an output typed `secret-ref`.
Core derives one `secretReads` requirement for each function receiving that binding. The optional
`SecretSource` on `CreateContext` is an interface for lazy lookup; no secret-store adapter or
policy implementation is supplied here.

## Functions, requirements and triggers

`physicalFunctions(config)` groups deployed roles. Split roles are individual functions named by
role; the remaining roles form a function named `shared`, even if only one role remains. Roles
and functions follow the core role order, independent of input order. Per-role settings in a
shared function merge if overlapping values agree; conflicting values fail. Core checks memory
128 to 1048576 MB and timeout 1 to 86400 seconds. Platform schemas can impose narrower limits
and accept extra settings such as `cpuMs`. `http` lists deployed roles to expose; only `ingest`
and `api` have HTTP apps. The standalone platform mounts exactly the configured apps.

`PORT_REQUIREMENTS` and `TOPIC_ROUTES` in `stack-requirements.ts` own the role matrix. For M1,
ingest needs store read, blob write/delete, KV read/write and queue produce; API needs store
read/write and blob read; consumer needs store read/write and blob read/write/delete and queue
consume. `ingest` is produced by ingest and consumed by consumer. The M4 `notifications` route is
produced and consumed by consumer and is currently derived even without archive; the M4
`archive.project` route is enabled when archive is selected, produced by cron and consumer, and
consumed by consumer. Archive selection adds the marked M4 store, blob staging and primary,
archive and KV requirements in the table. In particular cron needs staging write/list and also
primary blob read/delete for erasure. These are model requirements, not implemented M4 handlers.

Core validates that selected adapters support each active role / capability / purpose, derives
`DerivedGrant` records and binding scopes for physical functions, and groups duplicate grants.
A producer-only queue binding does not reach a function that only consumes that queue. Secrets
produce `SecretReadRequirement` entries. `deriveAccess`, `bindingsForRoles`, `deriveDeployment`
and `deriveTriggers` expose these derivations. Queue routes map all core topics to physical
keys; per-topic mode requires distinct physical queues, shared mode one physical queue. Queue
triggers are derived only for active topics, one per physical queue. Cron triggers come from
`CRON_JOBS` when archive is selected and the cron role is deployed; the handlers remain M4 TODOs.

For the exact view passed to `inputs`, the following declarations are copied from
`stack-model.ts` (the referenced `ArtifactRef`, `Binding`, `InfraValue` and `OutputRef` are also
in that file):

```ts
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
      topics: CoreTopic[];
      settings: QueueTriggerSettings;
    }
  | { kind: "cron"; functionId: string; name: string; schedule: string };
export interface DeploymentView {
  functions: DeploymentFunction[];
  triggers: DeploymentTrigger[];
}
```

Queue `topics.settings` is keyed by physical queue and carries `batchSize`, `maxConcurrency`,
`visibilityTimeoutSec` and `dlq` (`enabled`, optional `maxReceiveCount`). When the manifest's
`visibilityTimeout` is true and either the consumer's `timeoutSec` or queue visibility is set,
both must be set and visibility must be at least six times the derived physical function timeout.
When the capability is false, specifying a visibility timeout is rejected. If neither timeout is
specified, core cannot validate provider defaults: M2b must choose and check compatible defaults.
A DLQ must be supported by the queue; disabled DLQs cannot specify a receive count. `outputs` on
the stack maps names to validated output references; M2b must surface them.

## Graphs, existing resources and lifecycle

Validation checks module input / existing-substitution references in a provisioning graph and
`dependsOn` in a separate runtime construction graph. The module graph includes platform edges
for derived bindings, grants and queue triggers; a component that requires a platform output can
therefore form a cycle. Graph context is explicit rather than inferred from path text. The runtime
platform is implicitly ordered after all selections. Both graphs reject cycles. Nested plain stack
data is limited to `MAX_STACK_DEPTH` (128) before recursive parsing. User-supplied keys are checked
as own properties.

`existing` suppresses the corresponding module. It supplies only output names and nested map keys
reachable from active references, derived grants, triggers and scoped bindings. A newly reachable
output will require a corresponding supplied value on the next validation. Values that are
provided are still type-checked. A keyed lookup requires a statically inspectable existing map;
an opaque variable for the whole map cannot prove a required key is present. External policy
objects remain the operator's responsibility. This saves unused values at the cost of less
future-proof bring-your-own configuration than requiring every output.

Factories receive config, role-scoped bindings and explicit dependencies. Only queues receive
`topics` and `queueConsumers` (event source, physical queue, topics); platforms may receive named
`cronJobs`. Constructed adapters may expose `close()`. The CLI builds in dependency order, closes
in reverse order on failure and shutdown, and supplies root adapters to the platform by port kind.
The standalone platform owns migration and bootstrap; its `tokenDirectory` is configured
independently from the SQLite path. The local stack assigns both from `ERRTRAQ_DATA_DIR`.

## Worked AWS examples

The complete type-checked and validated illustrative fixtures are in
[`packages/core/src/infra-examples.test.ts`](../packages/core/src/infra-examples.test.ts). Both
include an illustrative archive selection so all three topics are active. Neither fixture runs an
AWS adapter or creates Terraform. This exact excerpt constructs the shared and per-topic stacks:

```ts
function exampleStack(mode: "shared" | "per-topic"): StackConfig {
  return {
    name: "example",
    providers: {
      aws: {
        source: "hashicorp/aws",
        version: "~> 6",
        region: "us-east-1",
        tags: { app: "errtraq" },
      },
    },
    platform,
    store: resource("store", ["read", "write", "delete"]),
    queue: queue(mode),
    blob: resource("blob", ["read", "write", "delete", "list"]),
    kv: resource("kv", ["read", "write"]),
    archive: resource("archive", ["read", "write", "delete"]),
    outputs: {
      ingest_url: output("platform", "ingest_url"),
      api_url: output("platform", "api_url"),
    },
  };
}
const shared = defineStack(exampleStack("shared"));
const perTopic = defineStack(exampleStack("per-topic"));
```

### Shared queue

`shared` uses `queue("shared")`: one physical key, `shared`, backs every topic. Core derives one
queue trigger, and functions get the policies for their required capabilities on that resource.
The platform configuration in the test splits all four roles and exposes ingest and API HTTP.

### Per-topic queues

`perTopic` uses the same factory with three physical keys. The following exact excerpt from the
fixture selects the topic mapping (the logical name containing a dot is not a physical key):

```ts
  const physical =
    mode === "shared"
      ? {
          ingest: "shared",
          "archive.project": "shared",
          notifications: "shared",
        }
      : {
          ingest: "ingest",
          "archive.project": "archive_project",
          notifications: "notifications",
        };
```

The corresponding resource and policy mapping is also copied from that fixture:

```ts
    resources: Object.fromEntries(
      keys.map((key) => [key, out("queues", key, "arn")]),
    ),
    capabilities: Object.fromEntries(
      ["produce", "consume"].map((capability) => [
        capability,
        Object.fromEntries(
          keys.map((key) => [key, out("policies", capability, key)]),
        ),
      ]),
    ),
```

The validated view has three queue triggers. Ingest gets only
`output("queue", "policies", "produce", "ingest")`; consumer gets the consume policy for
each physical queue and the producer policies required by the core topic table. Actual policy
contents and rendered Terraform remain M2b work.

## Cloudflare fit (types only)

The following type sketch is copied from the same compiling test file; it is not an implementation:

```ts
type CloudflareFit = {
  platform: PlatformSelection;
  bindings: {
    d1: Binding & { kind: "platform"; platformType: "d1" };
    queues: Binding & { kind: "platform"; platformType: "queue-producer" };
    r2: Binding & { kind: "platform"; platformType: "r2" };
    kv: Binding & { kind: "platform"; platformType: "kv" };
  };
  queueConsumer: Extract<DeploymentTrigger, { kind: "queue" }>;
  cron: Extract<DeploymentTrigger, { kind: "cron" }>;
};
```

A Workers manifest would use `authorization: "bindings"` and support `platform` bindings; D1,
Queues producers, R2 and KV can use the named binding types above. A queue consumer is represented
by a `DeploymentTrigger` queue variant, while a cron trigger uses the cron variant. The actual
binding payloads, consumer handling, provider modules, CPU settings and policy semantics remain
future platform / adapter work; this sketch does not establish that they are implemented.

## M2b / M2c handoff

M2b must render all reference kinds with their proper phase, escape literals, emit JSON variable
container validation, render only reachable existing substitutions, materialize per-purpose IAM
policies and secret-read permissions, surface stack outputs, and enforce compatible queue and
function defaults. It must also choose and document local standalone infra semantics. M2c must
satisfy artifact references with actual build locations, generate role-scoped entrypoints and
queue event-source mappings, and provide runtime secret sources. Neither `main.tf.json` nor HCL
is generated by this slice.
