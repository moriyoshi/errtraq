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

Adapters for external services run against the emulators in `docker/` (winterbaume for S3,
Lakekeeper for the Iceberg catalog, database servers) and Miniflare for Cloudflare. These runs
are opt-in. TODO(M3): record the exact commands here when the compose file lands.

## 3. End-to-end (when you touch ingest, the consumer, grouping, or the API)

Run the opt-in real SDK check on loopback:

```sh
pnpm e2e
```

The script builds the workspace, starts the local CLI on a free loopback port using a temporary
ignored data directory, sends real `@sentry/node` envelopes, checks grouping, API retrieval,
regression, gzip replay, overflow, paging, token rotation, restart recovery and shutdown. It uses
the SDK default transport and integrations and does not require a cloud account.
For manual use:

```sh
pnpm build
pnpm exec errtraq validate --stack stacks/local.ts
pnpm exec errtraq dev --stack stacks/local.ts
pnpm exec errtraq token rotate --stack stacks/local.ts
```

Node versions before 22.18 need `NODE_OPTIONS=--experimental-strip-types` to load the TypeScript
stack file. Local data defaults to the ignored `.errtraq/` directory; set `ERRTRAQ_DATA_DIR` and
`ERRTRAQ_PORT` to override the data directory and port. The API token is printed at startup and
persisted in `api-token` under the local data directory with mode 0600. The local stack permits
10,000 event items per minute; the standalone configuration can set or disable this limit.

## 4. Infra generation (when you touch `infra-gen`, an `infra` descriptor, or `infra/modules`)

TODO(M2): record the commands here. The check is: snapshot tests of the generated
`main.tf.json` per example stack pass, and `terraform validate` succeeds on each generated
root. Never run `terraform apply` as part of the gate.

## Pick your level

| You changed | Run |
|-------------|-----|
| Anything | 1 |
| A port, the contract suites, or an adapter | 1, 2 |
| Ingest, consumer, grouping, symbolication, API | 1, 3 |
| `infra-gen`, adapter `infra` descriptors, HCL modules, CLI build / generate | 1, 4 |
| Archival or erasure | 1, 2, plus the crash-safety and erasure tests described under "Verification" in ARCHITECTURE.md |
