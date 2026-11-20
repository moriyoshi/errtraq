# Infrastructure model (M2a design)

This document specifies the model to be reviewed before the M2b generator is written. The
model describes both the existing local process and an AWS Lambda stack; it does not create
resources, call Terraform, or implement AWS runtime adapters.

## References and resolution

Selections have stable, stack-qualified paths such as `blob`, `queue`, or `archive.catalog`.
A descriptor declares its output names and types. Its `out(name)` refers to its own output;
`output(path, name)` refers to another selection. These become Terraform module-output
expressions, except that an `existing` selection substitutes the corresponding supplied value.
Paths are not package names: two selections can use the same adapter with different paths.

`stackValue("name" | "region" | "tags")` resolves from stack metadata during generation.
`generationEnv(name)` reads an explicitly named environment variable at generation time and
fails if absent. `variable(name)` denotes a Terraform input declared by the stack (string, number, bool, string
list, or JSON); its
`sensitive` property belongs to that declaration, so the generator must never emit a sensitive
value in a tfvars file. `env(name)` is a runtime environment lookup: it is not read while
validating or generating and can be used in bindings or a configuration schema that explicitly
accepts a reference. Object key `kind` is reserved for reference tags in infrastructure values;
adapter config can still use unrelated `kind` fields. Config must be plain serializable data.
Plain values are
literal. Generated artifacts must never resolve runtime references using the generator's own
environment. Terraform module outputs cannot be resolved by the local CLI without `existing` values. Local
development treats CLI startup as its generation boundary for `generationEnv` references.
Terraform variables are read from their corresponding `TF_VAR_` environment values;
no variable values are written to a stack or generated file by the model.

## Bindings, grants and functions

A binding has a name, kind (`env`, `secret`, or `platform`), value, and function-role scope.
`secret` is a reference to a secret, not secret bytes; `platform` reserves an extensible
provider-specific type for future D1, R2 and queue objects. Module outputs used as secret
bindings must be declared `secret-ref` to distinguish an identifier from secret bytes. Names must be unique within each
function after roles are grouped, including roles that share a process. Bindings for disjoint
functions may reuse names. The builder supplies only the named bindings to the matching role. Co-located roles necessarily
share the union of their permissions. The current ingest service does read the active store for
project-key authentication, so an AWS ingest function needs narrowly scoped store read access.
A runtime `env()` binding
refers to a name already supplied by the execution environment; it does not cause the generator
to read or embed that value. Secret bindings must reference an output, a sensitive Terraform
variable, or an existing runtime environment name.

A grant names a role, an abstract capability, a resource output and a policy-document output.
The descriptor maps each declared capability to its policy output, and its module owns that IAM policy JSON;
the platform attaches that document to the role. Neither grants nor module inputs contain raw
provider-specific IAM rules in TypeScript. Output declarations make missing policies detectable.

Platform configuration supplies deployed roles, `split` roles and per-role memory, timeout and
architecture. Every split role becomes a separate function; remaining roles share one function.
The local platform uses one process and rejects split functions and per-function resource
settings, which it cannot apply. Bindings and grants are grouped by the resulting physical
function, not merely by role. Runtime support and pull/function incompatibility remain checked.

## Topics and cron

Core owns the topic registry. `ingest` is the existing event topic; `archive.project` and
`notifications` are reserved for later handlers. A queue descriptor maps every registry topic
to a physical queue key, producer roles, one consumer role, the producer binding name and its resource reference. Shared
mode requires one physical key, resource and consumer; per-topic mode requires distinct keys
and resources. Cloud producer routes require the scoped URL binding and the matching resource
grants; consumers require a consume grant. A shared queue produces one trigger, not one trigger
per logical topic. Runtime
construction receives the same topic-to-physical and producer-binding map alongside resolved
bindings. A shared queue must preserve the logical topic in the delivery envelope. Reserved topics have no M1
handler; archival handling is M4 work and notification handling is later work. An unknown
message must not be acknowledged merely because its topic is reserved.

Core also owns named cron jobs, schedules and roles. The stack selects enabled jobs, and the
platform derives one named trigger for each enabled job; unknown or duplicate jobs and roles
without a deployed function are invalid. M4 will enable archival, retention and erasure jobs.
The local M1 stack enables none, avoiding a fake successful implementation of those handlers.

## Nested selections and construction

Selections can contain named child selections. Paths extend through those children, so
`archive.catalog` and `archive.engine` appear in validation and generated imports independently.
`dependsOn` maps a runtime dependency name to another selection path. Module-input references and explicit runtime dependencies are checked in separate graphs, so
a runtime dependency does not create a spurious Terraform cycle. Factories receive
one context: `{ config, bindings, dependencies, topics }`. The CLI constructs dependencies
first, then the dependent selection, and hands the platform already constructed ports. The
resolved bindings and topic map come from the same selected descriptors used for provisioning.

## Provider metadata and existing resources

The stack records provider source and version constraints, region, default tags and an optional
backend type and config. Backend config accepts literals or generation-time environment values,
not Terraform variables, module outputs or runtime bindings; use provider-native environment
credentials rather than embedding backend secrets in generated files. Each module specifies a
provider, component, optional release metadata and declared outputs. Because these are checked-in
local HCL modules, the optional version is metadata, not a Terraform registry `version` argument. The future generator resolves `infra/modules/<provider>/<component>` relative to its
generated root; it must reject path traversal and must not assume the current working directory.

`existing` supplies values keyed by declared output name and suppresses that selection's module.
Every declared output must be supplied, even if it is not currently used, so adding a downstream
reference cannot silently produce an unresolved expression. References to existing outputs are
substituted; missing or undeclared outputs, self-referential substitutions and cycles are errors.
External policy-document values must be supplied just like resource identifiers. For example,
`existing: { queue_arn: variable("queue_arn"), queue_url: variable("queue_url"),
produce_policy: variable("produce_policy"), consume_policy: variable("consume_policy") }`
replaces every `out(...)` reference to that queue, including cross-selection references. An
archive descriptor can declare `inputs: () => ({ bucket: output("blob", "bucket") })` and a
runtime `dependsOn: { blob: "blob", catalog: "archive.catalog" }`; the two dependencies have
separate provisioning and construction meanings. Requiring all
declared outputs is intentionally conservative: it makes configuration changes fail early but
may ask bring-your-own users for outputs their current roles do not consume.

## Worked AWS example (illustrative; M2b implements it)

```ts
const queue = {
  module: { provider: "aws", component: "sqs", outputs: {
    queue_arn: "string", queue_url: "string", produce_policy: "json", consume_policy: "json",
  } },
  inputs: () => ({ name: stackValue("name"), region: stackValue("region") }),
  bindings: [{ name: "QUEUE_URL", kind: "env", roles: ["ingest", "cron"], value: out("queue_url") }],
  capabilities: { produce: "produce_policy", consume: "consume_policy" },
  grants: [
    { role: "ingest", capability: "produce", resource: out("queue_arn"), policy: out("produce_policy") },
    { role: "cron", capability: "produce", resource: out("queue_arn"), policy: out("produce_policy") },
    { role: "consumer", capability: "consume", resource: out("queue_arn"), policy: out("consume_policy") },
  ],
  topics: { mode: "shared", routes: {
    ingest: { physical: "events", producerBinding: "QUEUE_URL", producers: ["ingest"], consumer: "consumer", resource: out("queue_arn") },
    "archive.project": { physical: "events", producerBinding: "QUEUE_URL", producers: ["cron"], consumer: "consumer", resource: out("queue_arn") },
    notifications: { physical: "events", producerBinding: "QUEUE_URL", producers: ["cron"], consumer: "consumer", resource: out("queue_arn") },
  } },
};
// Illustrative stack.ts imports future M2b helpers; `sqs` owns the descriptor above.
import { awsLambda } from "@errtraq/platform-aws-lambda/stack";
import { dynamodbStore } from "@errtraq/store-dynamodb/stack";
import { sqs } from "@errtraq/queue-sqs/stack";
import { s3 } from "@errtraq/blob-s3/stack";
import { dynamodbKv } from "@errtraq/kv-dynamodb/stack";
export default defineStack({
  name: "example", region: "us-east-1", tags: { purpose: "example" },
  providers: { aws: { source: "hashicorp/aws", version: "~> 6.0" } },
  variables: { external_secret: { type: "string", sensitive: true } },
  backend: { type: "s3", config: { bucket: generationEnv("STATE_BUCKET"), key: "example.tfstate" } },
  platform: awsLambda({ roles: ["ingest", "api", "consumer", "cron"],
    split: ["ingest", "consumer"], settings: { consumer: { memoryMb: 512, timeoutSec: 30 } }, cron: [] }),
  store: dynamodbStore({}), queue: sqs({ mode: "shared" }), blob: s3({}), kv: dynamodbKv({}),
});
```

For `split: ["ingest", "consumer"]`, the generator should derive the following relationship
(the actual JSON/HCL shape belongs to M2b, and these identifiers are illustrative):

```hcl
module "queue" {
  source = "../../modules/aws/sqs"
  name   = "example"
  region = "us-east-1"
}
module "platform" {
  source = "../../modules/aws/lambda-app"
  functions = {
    consumer = {
      role        = "consumer"
      policies    = [module.queue.consume_policy]
    }
  }
  queue_triggers = {
    events = { function = "consumer", queue_arn = module.queue.queue_arn }
  }
}
```

The platform HCL attaches the adapter-provided consume policy to the consumer function and creates an
event source mapping from the queue ARN to the consumer function. If the queue is existing,
the same inputs are the user-supplied output replacements, not `module.queue.*`.

## Deferred

M2b owns concrete descriptors, HCL, provider policies, trigger rendering, secret delivery and
Terraform validation. M2c owns static entrypoints and bundles. Platform-specific Cloudflare
bindings and GCP resource/policy semantics need their own adapters and validation; the tagged
binding shape leaves room for them without pretending they already exist. Policy documents supplied for existing resources still
need review; the type checker cannot prove that their permissions are least privilege. Dynamic cron handlers,
archive engines and cross-provider deployment behavior remain later milestone work.
