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
pnpm test                        # or focused while iterating: pnpm --filter @moriyoshi/errtraq-<pkg> test
```

Fix violations and re-run until clean. `pnpm test` needs no external daemons, network, or
cloud credentials; a test that does must be opt-in and skip when its service is absent.

`pnpm lint` also enforces Workers layering for `packages/core`, `packages/http` and the
transitive workspace value imports of packages declaring `errtraqWorkersRuntime`. It also
checks the browser-target bundle, including bundled dependencies. Runtime entries cannot import
Node APIs or use Node globals; type-only imports and test files are excluded.

## 2. Contract suites (when you touch a port or an adapter)

Every adapter runs the matching suite from `packages/testing` (`activeStoreContract`,
`queueContract`, `blobStoreContract`, `archiveStoreContract`). When you change a port, extend
the contract suite first, then make every existing adapter pass it.

Postgres SQL-store contracts and query plans are opt-in:

```sh
pnpm test:postgres
```

This starts the pinned `postgres:17.6-alpine` image by digest on a random loopback-only port,
creates a separate schema for each contract instance, runs the complete active-store contract,
concurrent migrations and two-pool writes, byte-order, timeout/pool and large-table EXPLAIN
checks, and stops its container. It skips clearly when Docker is unavailable; the first run may
pull the image. The planner tests use default cost settings after `ANALYZE`; plans can differ
with other statistics, distributions and PostgreSQL configurations.

A standalone stack can select `postgres(variable("postgres_secret"))` from
`@moriyoshi/errtraq-store-sql/postgres/stack`. Declare `postgres_secret` as a non-sensitive string
stack variable holding the *name* of an environment variable, such as `DATABASE_URL`;
set that named environment variable to the connection URL. The standalone constructor resolves
that identifier locally without putting the URL in the stack or Terraform. This is an existing
external database and produces no module. Lambda still needs the M3g deployed secret source
and config-reference delivery before this selection is usable there.

M3f2's IAM connection path accepts `postgres({ mode: "iam", host, port, database, user,
region, resourceId, sslRootCert? })`. `sslRootCert` is a path to a PEM trust bundle, optionally
an environment or string-variable reference; it defaults to `/var/runtime/ca-cert.pem` for
Node Lambda ZIPs. AWS documents that path as its Amazon CA bundle; an operator using another
runtime or a container must supply and maintain a suitable bundle. RDS Proxy uses ACM/ATS
certificates, so its trust bundle must include the corresponding roots. Connections verify the
CA and endpoint hostname, and the pool's password callback signs a new 15-minute token for
each connection using current Lambda credentials. Existing open connections do not need token
renewal. The RDS IAM policy module and optional Lambda VPC settings are generated and mock-tested;
no IAM-enabled RDS connection is exercised by the local Postgres test. See [AWS Lambda RDS TLS requirements](https://docs.aws.amazon.com/lambda/latest/dg/services-rds.html)
and [RDS Proxy certificate guidance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html).

AWS emulator probes and the namespace lifecycle are opt-in:

```sh
pnpm aws-emulator:install              # install the checksum-verified pinned release (prebuilt where pinned, else built from source)
pnpm test:aws-emulated                 # probes and adapter contracts; skips absent builds
pnpm test:workers-smoke                # runs S3, SQS producer / delayed push and KV against local fakes in workerd
```

Winterbaume issue #61 prevents the store's concurrent transaction and CAS contracts from proving
atomicity. The command runs those unchanged cases against a cached, digest-pinned DynamoDB
Local Docker image when available and prints a skip otherwise; it never pulls an image.
The Winterbaume 40-writer diagnostic records the gap separately and is not a correctness or
contention benchmark. DynamoDB Local also runs the grouped in-process pipeline with four memory
queue workers, 200 and 500 hot events and background traffic, reporting transaction attempts,
group concurrency and drain time. The memory queue sends one record at a time, so it does not
measure FIFO batch efficiency. DynamoDB Local does not replace the M3h real AWS check.
The Local run also exercises concurrent deployed bootstrap with both DynamoDB store and KV;
`test:postgres` exercises it through separate Postgres pools. Secrets Manager bootstrap calls
use fake HTTP responses in local tests and still require an M3h real-AWS check.
To populate the cache explicitly, pull
`amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86`.

The installer keeps its download, binary and any source build under `.agents-workspace/tmp`. The
first install needs network access (a source build also needs substantial disk space); subsequent
runs are offline.
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
directory. The active-store AWS runtime adapter is still an M3 stub.

```sh
pnpm infra:validate
pnpm infra:mutate
```

This checks module formatting, initializes each module in an ignored temporary directory with a
plugin cache under `.agents-workspace/tmp`, validates it, and runs Terraform mock-provider tests
without credentials. AWS provider versions 6.32.1 and 6.73.0 are pinned for the minimum and
recorded latest-tested runs (the `lambda-app` module and the generated roots, which contain it, need at least 6.73.0 because 6.32.1 rejects `nodejs26.x`, so they run on 6.73.0 only); any deprecation warning fails the check. On a cache hit, init uses
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
pnpm infra:apply-emulated --postgres-only  # focused IAM Postgres fixture
pnpm infra:apply-emulated --fifo-only      # FIFO queue and DLQ with named emulator exceptions
pnpm infra:apply-emulated --grouped-only   # grouped shared and per-topic roots
```

It uses pinned AWS provider 6.73.0 and loopback-only provider settings, with
independent Terraform data directories and a read-only plugin directory. It applies the
DynamoDB, SQS and Lambda modules and generated shared and per-topic example stacks,
checks resources and policies through service APIs, compares repeat and change plans,
and checks API inventories after destroy. The Postgres fixture also checks exact RDS connect
and network-interface role policies; the pinned emulator drops Lambda VPC configuration, so a
self-verifying named exception omits that block only from a temporary module copy. Provider queue-stabilization and deletion waits
make this a lengthy opt-in run. A feature-enabled fixture checks the three-topic
queue transition; the grouped examples enable `ingest` and `record`. Named exceptions are listed in
`scripts/aws-emulated/gaps.json`, logged visibly, linked to
[WINTERBAUME_GAPS.md](./WINTERBAUME_GAPS.md), and checked to ensure each gap still reproduces. Temporary module overrides exclude the unusable ownership-control resource and unsupported FIFO
settings; tracked modules and generator output are unchanged.
For FIFO, a temporary SQS module copy omits high-throughput settings that the emulator discards;
the test applies and destroys the FIFO queue and FIFO DLQ, and checks their API readback. It
cannot prove FIFO group exclusion or event group attributes on the pinned emulator.
Lifecycle header, DynamoDB encryption and deletion protection, EventBridge retry/DLQ settings and partial-batch readback
are exercised by the updated pin rather than excluded.

This does not prove IAM or TLS-only policy enforcement, Lambda code execution, DynamoDB
encryption at rest or deletion protection, S3 lifecycle or ownership-control behavior,
partial-batch delivery, EventBridge retry/DLQ behavior, or tag persistence. These need
real AWS verification or a fixed emulator. The normal mock-provider checks still cover the
full Terraform module declarations at both pinned provider versions. The earlier provider 6.30.0 GSI repeat-plan issue is recorded separately in `WINTERBAUME_GAPS.md`.

`pnpm infra:mutate` requires the cached 6.73.0 provider. It verifies unmodified baselines, applies
each mutation from `scripts/infra-mutations.json` in its own temporary copy, and reports whether
validation, HCL tests, the output-shape check or the static production-metadata lifecycle check detected it. It also mutates generated roots to
check detection of missing or misassigned policies, missing bindings or triggers, and an unescaped
literal. `pnpm infra:validate` additionally builds the generator, generates both AWS stacks and
seven variants (including an IAM Postgres/VPC fixture and a fake existing archive to exercise cron), and runs `terraform fmt -check`,
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
