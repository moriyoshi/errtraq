# Infrastructure model

This document describes the implemented infrastructure model in `packages/core/src/stack-*.ts`,
the deployed construction API and the local runtime. AWS descriptors, HCL modules, Terraform
generation and static entrypoints are implemented; AWS runtime adapters remain M3 work.
The illustrative descriptors below are test fixtures.

## Selections and descriptors

A `StackConfig` names a platform, store, queue, blob, KV and optional archive, along with
providers, variables, backend, optional output references and optional capability requirements.
`protection` defaults to `production`; `disposable` explicitly permits AWS table / bucket teardown.
A selection contains a manifest, `config`, a `runtimeModule`, an `infra` descriptor, optional
provider entry, runtime `dependsOn` aliases, `children`, and `existing` substitutions. Parent
manifests declare `childKinds` for every child alias; a platform cannot be a child. The module
address is `moduleName(path)`, replacing dots by underscores. Validation rejects collisions.
Selection, purpose and physical keys use lowercase identifiers (`[a-z][a-z0-9_-]*`); output
names and binding names use `[A-Za-z_][A-Za-z0-9_]*`. The logical topic `archive.project` is
therefore distinct from an identifier such as `archive_project`.
The variable name `__proto__` is reserved and rejected before parsing, because the schema
parser would otherwise silently discard that own property.

A descriptor provides `module` (provider, component, output types and optional
`sensitiveInputs`), `inputs(config, deployment)`, `resources`, `capabilities`, `bindings`, and
for queues `topics`. The second argument is available to every descriptor and is the frozen
`DeploymentView`; platform inputs use it to wire compute. A resource maps a purpose / physical
key to an `InfraValue`. A capability maps each purpose to its own `OutputRef` policy or `null`
when no IAM policy is needed. Bindings name their resource purpose and may limit themselves to
specific capabilities; they do not list function roles. `module.outputs` supports `string`,
`string[]`, `json`, `json-document`, `secret-ref`, and recursive `{ map: OutputType }`. `out("queues", key,
"arn")` selects a key path within the current selection; `output("queue", "queues", key,
"arn")` names another selection. Output path keys match `[A-Za-z_][A-Za-z0-9_-]*`; they may
contain uppercase letters and hyphens. The generator renders references
rather than JSON-serialize them.

The HCL source for a module is `infra/modules/<provider>/<component>`; the generator resolves
it relative to its generated root. `module.version` was removed: provider
version constraints live in stack provider entries, while module resources live in HCL.

Manifests declare runtime compatibility and required environment features. Store capabilities
include text search, range support and delete strategy; queue capabilities include delivery,
size, delay, DLQ and `visibilityTimeout`. Platform manifests declare `runtime`, `compute`,
`authorization` (`iam`, `bindings`, or `none`), an optional `maxStackNameLength`, supported `bindingKinds`, reserved exact names
or prefix patterns ending in `*`, and provided environment features. Adapter `requires` and
platform `provides` use `writable-filesystem`, `long-lived-process`, and
`shared-process-state`. The last requires a declared guarantee and one long-lived physical
function. AWS Lambda declares a 40-character stack-name limit, checked before generation.
`none` authorization likewise requires one long-lived physical function. IAM requires
policy outputs for every required capability and purpose; binding authorization requires a
platform producer binding for active queue routes. Environment bindings must be scalar strings.
The module provider named `local` does not require provider metadata; other modules do. Child
bindings go to every function using the parent port, subject to their optional capability filter.
Child capability policies are granted to functions with the matching parent capability. Each
child resource must have a binding or capability, and capabilities and filtered bindings without
an active matching parent requirement are rejected. Child topic mappings are not supported.

The default AWS contract test compares descriptor types and referenced paths with a committed
snapshot of mock-provider output shapes. The opt-in infrastructure gate captures actual Terraform
outputs at both pinned provider versions and compares them with the snapshot. Output descriptions
are informational; Terraform `validate` alone does not prove an output's type or keys. The model validates reference types
and policy output placement, but it does **not** inspect a
policy document or module input to prove that it contains no raw provider IAM or that its policy
is least privilege. The adapter author and HCL module must provide that guarantee.

## Reference phases and literals

All reference objects use the global `Symbol.for("@errtraq/infra-reference")` tag and the
exported guards (`isOutputRef`, `isStackRef`, `isEnvRef`, `isVariableRef`, `isArtifactRef`,
`isInfraRef`). They are in-process values, not JSON data. They must be rendered explicitly:

| Constructor | Resolution |
|---|---|
| `out(name, ...keys)`, `output(selection, name, ...keys)` | Terraform module output expression, or an `existing` substitution. |
| `stackValue("name")` | Generation-time stack name. |
| `stackValue("protection")` | Generation-time protection setting, defaulting to `production`. |
| `stackValue("region" / "tags", provider?)` | Generation-time provider value. Without a provider, use the owning selection's module provider. |
| `variable(name)` | Declared Terraform variable; CLI runtime reads `TF_VAR_<name>`. |
| `env(name, options?)` | Runtime environment lookup; optional string default and suffix, and optional numeric conversion. |
| `generationEnv(name)` | Generation-time lookup, currently valid only in backend config. The generator reads the caller-supplied map and fails if absent. |
| `artifact(functionId)` | Build-time artifact location, valid only in platform module inputs; M2c supplies it. |

`configReference(schema)` permits that schema's literal values, runtime `env` or `variable`
references. Validation rejects output, stack, artifact and generation-time references in adapter
config even if an adapter schema accepts arbitrary values. A platform's `configReferenceKinds`
whitelists the runtime kinds it can supply; absent means none. Standalone supports `env` and
`variable` from its process environment; Lambda declares no runtime config reference kinds
and rejects both in adapter config until delivery is implemented. The separate platform-only
`infrastructureConfigReferences` map permits typed Terraform variables for explicitly named
top-level infrastructure fields, without delivering those values to adapter runtime config. The runtime resolves supported references before `create`. A resolved stack is
branded and its copied data objects are deeply frozen, so core does not re-run transforming
adapter schemas on the original resolved object. A structural copy retains the brand but is not
cached; validation rejects it with a clear error rather than re-parsing transformed configuration. Shared Zod schema instances and executable functions remain unfrozen; Zod uses
lazy initialization. Do not mutate them after resolving.

A `json` output represents a native object or array. A JSON stack variable is supplied as JSON
text in a Terraform `string` variable and the generator must use `jsondecode(var.name)` where a
structured value is needed; validate that the decoded value is an object or array. The CLI parses
the same `TF_VAR_` text with `JSON.parse` and rejects scalars. `terraformVariableType("json")`
returns `string`; `string[]` maps to `list(string)`. A `json-document` output is JSON-encoded
text. Policy outputs must use that type, so different IAM policy shapes can coexist in a
`list(string)`. Existing literal documents must parse as JSON; string variables can supply them
at deployment. Core cannot prove the contents provide the claimed provider permissions.

Literal strings may contain Terraform template introducers. `terraformLiteral(s)` returns
`{ value: s, needsEscaping }` without changing the data; `escapeTerraformLiteral(s)` escapes
both `${` and `%{`. The generator applies this to literal strings, including nested values and
object keys, without escaping expressions rendered from reference objects. Infra
object keys and provider tag keys are restricted to ASCII letters, digits, underscore, dot,
slash, colon, at sign, plus, space and hyphen; unsafe keys are rejected before generation. These helpers do not
perform generation themselves.

Providers are keyed entries with `source`, `version`, optional `region` and `tags`; provider keys
also act as qualifiers. A selection's optional `provider` selects an entry, defaulting to its
module's provider family; unqualified stack provider values use that same entry. AWS provider
sources require a region regardless of the entry name. Only `s3` and `local` backends are supported;
their scalar non-secret metadata keys are allowlisted. Backend credentials must come from the
backend's own environment, never config values or `generationEnv`. Backend values may be literals
or `generationEnv`, not Terraform variables or module/runtime references. There is currently no
separate stack-metadata environment-reference field. Sensitive variables are rejected everywhere
except module inputs whose top-level names appear in `module.sensitiveInputs`; their handling by
Terraform and the provider module still matters for state. A secret binding instead carries a
non-sensitive string variable identifying an existing secret or an output typed `secret-ref`.
Core derives one `secretReads` requirement for each function receiving that binding. The optional
`SecretSource` on `CreateContext` is an interface for lazy lookup; no secret-store adapter or
policy implementation is supplied here.

### Generator inputs and build artifacts

A generator calls each selected descriptor as `inputs(selection.config, deriveDeployment(stack))`
using the validated stack and renders references according to their phase. It emits Terraform
provider requirements by source and version and provider configurations per entry. For example,
`hashicorp/aws` uses `provider "aws"` with `region` and `default_tags { tags = ... }`. A selection
using `provider: "aws_eu"` must pass `providers = { aws = aws.aws_eu }` to its module; the
corresponding provider block has `alias = "aws_eu"`. Other provider sources need their own mapping.

M2c supplies a build manifest keyed by physical function id. Core exports its entry shape:

```ts
interface BuildArtifact {
  path: string;        // ZIP file for Lambda
  handler: string;     // Lambda currently requires index.handler
  runtime: string;     // Lambda module currently requires nodejs22.x
  contentHash: string; // base64 SHA-256 of the ZIP bytes
}
```

`artifact(functionId)` references that entry; the current Lambda descriptor's `artifact` input
is the `path` string. The HCL accepts handler and runtime inputs and computes
`filebase64sha256(path)` itself; the current builder requires `index.handler` and `nodejs22.x`
and the CLI checks that the manifest agrees. A non-sensitive stack
variable may declare a type-checked literal `default`. M2b emits those defaults in
`terraform.tfvars.json` (JSON defaults encoded as JSON text because their Terraform type is
`string`); declarations without defaults are supplied externally. Sensitive defaults are rejected
and sensitive values must never be written to tfvars. Runtime `TF_VAR_` overrides defaults.

## Functions, requirements and triggers

`physicalFunctions(config)` groups deployed roles. Split roles are individual functions named by
role; the remaining roles form a function named `shared`, even if only one role remains. Roles
follow the core role order, independent of input order; split functions appear first in that order,
with `shared` last. Moving a role into or out of `split` changes its function assignment and can
replace functions; an existing split role always retains its role-name id and the shared id stays
`shared`. Per-role settings in a
shared function merge if overlapping values agree; conflicting values fail. Core checks memory
128 to 1048576 MB and timeout 1 to 86400 seconds. Platform schemas can impose narrower limits
and accept extra settings such as `cpuMs`. `http` lists deployed roles to expose; only `ingest`
and `api` have HTTP apps. The standalone platform mounts exactly the configured apps.

`PORT_REQUIREMENTS` and `TOPIC_ROUTES` in `stack-requirements.ts` own the role matrix. For M1,
ingest needs store read, blob write/delete, KV read/write and queue produce; API needs store
read/write and blob read; consumer needs store read/write and blob read/write/delete and queue
consume. Blob read includes the prefix-scoped list access needed to distinguish missing objects.
Deployed cron also needs primary blob read / list and ingest-queue produce to recover staged
envelopes; M3 must schedule that job. `ingest` is produced by ingest and cron, and consumed by consumer. The M4 `notifications` route is
produced and consumed by consumer and is enabled only by `features.notifications: true`; the M4
`archive.project` route is enabled when archive is selected, produced by cron and consumer, and
consumed by consumer. Archive selection adds the marked M4 store, blob staging and primary,
archive and KV requirements in the table. In particular cron needs staging read/write/delete/list and also
primary blob read/delete for erasure. These are model requirements, not implemented M4 handlers.

Core validates that selected adapters support each active role / capability / purpose, derives
`DerivedGrant` records and binding scopes for physical functions, and groups duplicate grants.
A producer-only queue binding does not reach a function that only consumes that queue. Secrets
produce `SecretReadRequirement` entries. `deriveAccess`, `bindingsForRoles`, `deriveDeployment`
and `deriveTriggers` expose these derivations. Queue routes map all core topics to physical
keys; per-topic mode requires distinct physical queues, shared mode one physical queue. Queue
triggers are derived only for active topics, one per physical queue. Cron triggers come from
`CRON_JOBS` when archive is selected and the cron role is deployed. Generated Lambda entries use
the core cron registry: known M4 placeholders log that they are not implemented, and unknown or
missing job names log an error and return without retrying.

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
      /** Environment binding carrying the runtime event-source identifier. */
      eventSourceBinding?: string;
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
specified, core cannot validate provider defaults. AWS uses compatible defaults of 180 and 30 seconds.
A DLQ must be supported by the queue; disabled DLQs cannot specify a receive count. `outputs` on
the stack maps names to validated output references which the generator surfaces.

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
documents remain the operator's responsibility. Existing queue visibility, DLQ and other trigger
settings describe a promise about the external queue; core cannot inspect or enforce them. This saves unused values at the cost of less
future-proof bring-your-own configuration than requiring every output.

Regenerating a marked root preserves Terraform working files, including `.terraform`, lock
files, state, plans and crash logs. A marker for another stack is rejected. Build metadata must
not record absolute input paths. In free text, path hygiene checks complete repository or home
path prefixes with at least two components; one-component roots such as `/app`, `/src` and
`/root` are deliberately ignored because those strings commonly denote application paths.

Factories receive config, role-scoped bindings, explicit dependencies and the host-supplied
runtime environment. The latter remains a live lookup so adapters can refresh ambient credentials;
it is distinct from the role-scoped bindings. Only queues receive
`topics` and `queueConsumers` (event source, physical queue, topics); platforms may receive named
`cronJobs`. Constructed adapters may expose `close()`. Local CLI construction builds all selections
in dependency order and supplies root adapters to the platform by port kind. For deployed functions,
`constructDeployedStack(stack, functionId, environment, loadModule)` is exported by core for M2c.
It constructs only required ports, their children and runtime dependencies, reads each scoped binding
by name, rejects missing or empty binding values, and never resolves output references in runtime bindings. The caller supplies a static
module loader and calls `close()` on shutdown; failure also closes in reverse construction order.
For function platforms supporting env bindings, each queue trigger adds an env binding named
`ERRTRAQ_QUEUE_SOURCE_<physical>` (uppercase, hyphens changed to underscores) to the consumer
function. Its value is the queue resource reference, resolved by Terraform; runtime uses the
delivered value as `queueConsumers.eventSource`. Collisions and reserved names fail validation.
Platforms without env bindings need their own runtime binding mechanism.
Deployed and local construction reject active queue topics with no implemented consumer handler;
currently only `ingest` is implemented. Lambda DLQ receive counts must cover the consumer
missing-claim limit (currently five attempts).
The standalone platform owns migration and bootstrap; its `tokenDirectory` is configured
independently from the SQLite path. The local stack assigns both from `ERRTRAQ_DATA_DIR`.

## Worked AWS examples

The complete type-checked and validated illustrative fixtures are in
[`packages/core/src/infra-examples.test.ts`](../packages/core/src/infra-examples.test.ts). Both
include an illustrative archive selection. The per-topic fixture also enables notifications so
all three topics are active. Neither fixture runs an
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
const perTopic = defineStack({
  ...exampleStack("per-topic"),
  features: { notifications: true },
});
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
each physical queue and the producer policies required by the core topic table. The AWS modules
provide policy documents, and the generator renders Terraform for selected stacks.

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

`@errtraq/infra-gen` turns a resolved stack into deterministic Terraform JSON files without I/O.
Its caller supplies the output and module directories, generation-time environment values, and a
map from function IDs to artifact paths relative to the generated root. Both directory paths must
be POSIX paths, either both absolute or both relative to the same root. Standalone returns a
`not-applicable` result because it has no Terraform infrastructure. The caller is responsible for
writing files. The generated AWS roots are exercised with mock providers at both pinned AWS
provider versions by `pnpm infra:validate`; this checks their derived bindings, policies and
triggers without a cloud account. `errtraq build` writes a manifest and role-scoped Lambda ZIPs
under `dist/<stack>` by default; `errtraq infra generate` verifies their hashes and renders paths
relative to its output directory. An explicit `--allow-missing-artifacts` permits placeholders.
Standalone builds a single Node bundle and a non-root Node 22 Dockerfile, and has no Terraform.
The Dockerfile opts into `ERRTRAQ_HOST=0.0.0.0`, stores data in `/data` and probes `/health`;
ordinary local runs default to loopback. Standalone's optional `publicUrl` config selects the
printed DSN's public HTTP(S) origin; otherwise a wildcard listener uses localhost with a note.
Deployed construction first derives
`deployedPlan` and then runs `constructDeployedPlan`, preserving the same role and binding scopes
as `constructDeployedStack` while allowing entrypoints to import only needed adapters. AWS S3,
SQS and DynamoDB KV selections use their `/runtime` exports, which omit the stack schema and
Zod; their `/stack` exports remain for stack authors. Their runtime adapters are implemented;
the active-store AWS runtime adapter and secret sources are M3 work.


## RDS IAM and Lambda VPC

A Postgres IAM selection uses the `aws/rds-iam-access` module: it creates no database and
returns the same exact-resource `rds-db:connect` policy for read, write and delete. These
capabilities scope which functions need a connection, but **do not** constrain their SQL:
all use one PostgreSQL user and its database privileges. `errtraq validate` exposes that
limitation. The provider's account and the configured region, database resource ID and user
form the ARN. The separate password-secret mode continues to use an existing database.

`awsLambda` optionally accepts `vpcSubnetIds` and `vpcSecurityGroupIds` as literal ID lists
or non-sensitive `string[]` variables. These fields are declared through the platform
manifest's `infrastructureConfigReferences` map, which permits typed variables for those
fields without enabling runtime config references for adapters. They must both be empty or
both nonempty; Terraform rechecks after references resolve. Every physical function receives
the VPC configuration and an execution-role network-interface policy. EC2 network-interface actions require a wildcard
resource and are also available to the function code; Lambda's documented source-function deny
is an optional operator defense. No network infrastructure is created. Private subnets need NAT
or appropriate S3, DynamoDB, SQS and Secrets Manager VPC endpoints, including correct DNS,
routes and security-group rules, for the adapters' HTTPS calls.
