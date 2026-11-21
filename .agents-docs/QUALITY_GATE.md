# Quality gate

The standard verification an agent (or human) runs before declaring a change complete.

## Purpose / when to use

Run this gate:

- Before declaring any change complete.
- Before making a commit that a task brief asked for.
- Before claiming "CI should pass" or "this is green".

Match the depth of the gate to what you touched (see "Pick your level" at the end). Every
change runs section 1 at minimum.

## 1. Workspace gate (always)

```sh
pnpm install --frozen-lockfile   # only if dependencies changed; otherwise skip
pnpm typecheck
pnpm lint
pnpm test                        # or focused while iterating: pnpm --filter @errtraq/<pkg> test
```

Fix violations and re-run until clean. `pnpm test` needs no external daemons, network, or
cloud credentials; a test that does must be opt-in and skip when its service is absent.

`pnpm lint` also enforces the layering rule: `packages/core` and `packages/http` must not
import `node:*` or use `Buffer` / `process`.

## 2. Contract suites (when you touch a port or an adapter)

Every adapter runs the matching suite from `packages/testing` (`activeStoreContract`,
`queueContract`, `blobStoreContract`, `archiveStoreContract`). When you change a port, extend
the contract suite first, then make every existing adapter pass it.

AWS emulator probes and the namespace lifecycle are opt-in:

```sh
pnpm aws-emulator:install              # build the verified, unmodified pinned server
pnpm aws-emulator:install-s3-patched   # build the verified local UTF-8 patch for S3 contracts
pnpm test:aws-emulated                 # runs probes plus SQS and S3 contracts; skips absent builds
pnpm test:workers-smoke                # runs bundled S3 and SQS against local fakes in workerd
```

The installer keeps its source, Cargo cache and build under `.agents-workspace/tmp`. The
first build needs network access and substantial disk space; subsequent runs are offline.
Tests bind a free loopback port, derive their DynamoDB and SQS shapes from the HCL modules,
and never use AWS credentials. See [M3_EMULATOR_SUPPORT.md](./M3_EMULATOR_SUPPORT.md)
for the probed operations and limitations. Other service contracts use the relevant local
emulator (for example Lakekeeper or Miniflare) and remain opt-in.

## 3. End-to-end (when you touch ingest, the consumer, grouping, or the API)

Run the opt-in real SDK check on loopback:

```sh
pnpm e2e
pnpm e2e --bundle               # also exercise the built standalone server
pnpm container:check            # optional: Docker image and SDK e2e on a random host port
```

The script builds the workspace, starts the local CLI on a free loopback port using a temporary
ignored data directory, sends real `@sentry/node` envelopes, checks grouping, API retrieval,
regression, gzip replay, overflow, paging, token rotation, restart recovery and shutdown. It uses
the SDK default transport and integrations and does not require a cloud account.
`pnpm container:check` skips if Docker is unavailable. With Docker it builds the generated
non-root Node 22.23 image, checks its health endpoint, and runs the same e2e against a temporary
container and data directory under the repository's ignored workspace. The Docker daemon must be
able to mount that path (with Colima, keep the repository under the user's home directory). The
base image may need to be downloaded on the first run. Bind-mounted data must be writable by the
container's user.
For manual use:

```sh
pnpm build
pnpm exec errtraq validate --stack stacks/local.ts
pnpm exec errtraq dev --stack stacks/local.ts
pnpm exec errtraq token rotate --stack stacks/local.ts
```

Node.js `^22.18.0 || >=23.6.0` is required for loading TypeScript stack files. Local data defaults to the
ignored `.errtraq/` directory; set `ERRTRAQ_DATA_DIR` and
`ERRTRAQ_PORT` to override the data directory and port. `ERRTRAQ_HOST` opts into a different
listen address; it defaults to `127.0.0.1`. The generated container explicitly sets it to
`0.0.0.0` and uses `/data` as its volume. The API token is printed at startup and persisted in
`api-token` under the local data directory with mode 0600. The local stack permits
10,000 event items per minute; the standalone configuration can set or disable this limit.

## 4. Infra generation (when you touch `infra-gen`, an `infra` descriptor, or `infra/modules`)

For a deployed stack, `pnpm exec errtraq build --stack stacks/aws-dynamodb.ts` builds ZIPs and
`pnpm exec errtraq infra generate --stack stacks/aws-dynamodb.ts` renders their paths and verifies
their hashes. Generation writes only inside the repository and requires an empty or marked output
directory. AWS runtime adapters are still M3 stubs.

```sh
pnpm infra:validate
pnpm infra:mutate
```

This checks module formatting, initializes each module in an ignored temporary directory with a
plugin cache under `.agents-workspace/tmp`, validates it, and runs Terraform mock-provider tests
without credentials. AWS provider versions 6.32.1 and 6.73.0 are pinned for the minimum and
recorded latest-tested runs; any deprecation warning fails the check. On a cache hit, init uses
the cache as a filesystem mirror and does not contact the registry. A cache miss downloads the
pinned version. Mock output values are reduced to shapes and compared with the committed
`infra/modules/aws/output-shapes.json`; the default test compares the snapshot with descriptor
types and every referenced output path. When deliberately changing output shapes, run
`UPDATE_INFRA_SHAPES=1 pnpm infra:validate` and review the snapshot diff.

The opt-in real-provider support inventory for the pinned local Winterbaume server is:

```sh
pnpm aws-emulator:install   # one-time verified build, if absent
pnpm infra:validate         # fills the two pinned provider versions if needed
pnpm infra:probe-emulated   # local Terraform applies; reports observed failures as inventory
```

The probe copies no changes into modules or generated roots, writes the provider override
and Terraform data into a new ignored directory, and uses the shared provider cache only as
an offline read-only plugin directory. It uses dummy credentials, routes AWS endpoints to
loopback, blocks other HTTP(S) destinations and stops the in-memory server on completion.
It probes module and generated-root applies with both pinned provider versions; an apply may
time out after 90 seconds. This is an inventory command, not a passing integration gate or
proof of the complete M3a2 workflow. See [WINTERBAUME_GAPS.md](./WINTERBAUME_GAPS.md).

The opt-in emulator apply workflow is:

```sh
pnpm infra:apply-emulated
```

It uses pinned AWS provider 6.73.0 and loopback-only provider settings, with
independent Terraform data directories and a read-only plugin directory. It applies the
DynamoDB, SQS and Lambda modules and generated shared and per-topic example stacks,
checks resources and policies through service APIs, compares repeat and change plans,
and checks API inventories after destroy. Provider queue-stabilization and deletion waits
make this a lengthy opt-in run. A feature-enabled fixture checks the three-topic
queue transition; the actual examples enable only `ingest`. Named exceptions are listed in
`scripts/aws-emulated/gaps.json`, logged visibly, linked to
[WINTERBAUME_GAPS.md](./WINTERBAUME_GAPS.md), and checked to ensure each gap still reproduces. Temporary module overrides exclude only the
unusable lifecycle and ownership-control resources and partial-batch readback; tracked
modules and generator output are unchanged.

This does not prove IAM or TLS-only policy enforcement, Lambda code execution, DynamoDB
encryption at rest or deletion protection, S3 lifecycle or ownership-control behavior,
partial-batch delivery, EventBridge retry/DLQ behavior, or tag persistence. These need
real AWS verification or a fixed emulator. The normal mock-provider checks still cover the
full Terraform module declarations at both pinned provider versions. The earlier provider 6.30.0 GSI repeat-plan issue is recorded separately in `WINTERBAUME_GAPS.md`.

`pnpm infra:mutate` requires the cached 6.73.0 provider. It verifies unmodified baselines, applies
each mutation from `scripts/infra-mutations.json` in its own temporary copy, and reports whether
validation, HCL tests or the output-shape check detected it. It also mutates generated roots to
check detection of missing or misassigned policies, missing bindings or triggers, and an unescaped
literal. `pnpm infra:validate` additionally builds the generator, generates both AWS stacks and
six variants (including a fake existing archive to exercise cron), and runs `terraform fmt -check`,
offline `init -backend=false`, `validate` and a
mock-provider `terraform test` apply for each at both pinned provider versions. The test compares
actual function environments, policies, queue and cron triggers, and HTTP outputs against the
derived deployment view; it checks existing selections create no resources and sensitive values
do not appear in generated files or non-sensitive outputs. The default gate runs only
Terraform mock-provider applies; the explicit opt-in emulator command also applies resources
against its local in-memory server.

## Pick your level

| You changed | Run |
|-------------|-----|
| Anything | 1 |
| A port, the contract suites, or an adapter | 1, 2 |
| Ingest, consumer, grouping, symbolication, API | 1, 3 |
| `infra-gen`, adapter `infra` descriptors, HCL modules, CLI build / generate | 1, 4 |
| Archival or erasure | 1, 2, plus the crash-safety and erasure tests described under "Verification" in ARCHITECTURE.md |
