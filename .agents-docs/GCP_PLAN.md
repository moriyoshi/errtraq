# GCP plan: Firestore, Cloud SQL, Pub/Sub, GCS and Cloud Run

Written 2026-11-25 from ARCHITECTURE.md, CLAUDE.md, OVERVIEW.md, M4_PLAN.md, DYNAMODB_DESIGN.md, COST_ESTIMATE.md, TODO.md,
the code on `main` at that date, and the GCP documentation cited inline (fetched the same day). This is a plan, not a design
change: ARCHITECTURE.md stays canonical, and where this plan differs from it the difference is called out. Nothing here has
been built or verified on a real GCP project. Statements marked "to verify" were not confirmed by the fetched pages.

## 0. Owner decisions already taken (2026-11-25)

- Active store: both a new `store-firestore` adapter (the serverless analogue of `store-dynamodb`) and Cloud SQL for
  PostgreSQL wiring for the existing postgres dialect in `store-sql` (IAM database authentication, like the RDS path).
- Queue: Pub/Sub push (push subscriptions to Cloud Run, OIDC authentication, dead-letter topic, retry policy) as
  `queue-pubsub`. Cloud Tasks is out for now.
- Blob: the native GCS JSON API as `blob-gcs` (fetch-based, OAuth access tokens from the metadata server or a service
  account, no HMAC keys, Workers-compatible per the layering rules).
- Compute: Cloud Run (`packages/platforms/cloud-run`). It cannot start until M4i (in progress, edits core role,
  requirement and validation files) merges.

Owner decisions taken 2026-11-26:

- D7: no default region. The region must be provided explicitly in every GCP stack config (and example stacks take it
  from a required input), never defaulted.
- D8: a real GCP project comes later, when G5 is ready. Until then everything is built and tested against emulators;
  no early real-service spike.
- The other open decisions (D1 to D6, D9 to D14) await the owner's review. G0 to G4 start now on the recommendations
  as provisional choices, keeping their dependence on D4 (Firestore client), D6 (emulators), D9 (Cloud SQL transport)
  and D10 (secrets) behind narrow seams so a different answer is a local change.

## 1. Status

### 1.1 What GCP can reuse today

| Area | State | Where |
|---|---|---|
| Ports and contract suites | `ActiveStore`, `Queue`, `BlobStore`, `KV`, `ArchiveStore` ports; `activeStoreContract`, `queueContract`, `blobStoreContract`, KV and archive suites run against fakes and emulators. A GCP adapter is "done" when its suite passes. | `packages/core/src/ports.ts`, `packages/testing/src/contracts.ts` |
| Adapter triple | `manifest`, `create(config, bindings)`, `infra` plus a `stack.ts` selection helper (`sqsQueue()`, `postgres()`), a `runtime` subpath that carries the heavy imports. | `packages/adapters/*/src/stack.ts` |
| Reference adapters | `store-dynamodb` (single table, sparse keys-only GSIs, strong pointers, grouped `recordEvents`), `queue-sqs` (push source, per-physical-queue settings, DLQ, FIFO grouping), `blob-s3` (aws4fetch, Workers-safe), `kv-dynamodb` (`runtimes: ["node", "workers"]`). | `packages/adapters/` |
| Postgres | Kysely dialect with an RDS IAM token pool (`rdsIamPoolConfig`), CA pinning, proxy handling, administrator-secret `provisionIamUser`, `postgres({ mode: "iam" })` selection. | `packages/adapters/store-sql/src/postgres*.ts` |
| Infra abstraction | `InfraDescriptor` (module, inputs, bindings, capability policy outputs, resources, topic mapping), `DeploymentView` (functions, triggers), `PlatformManifest` (`authorization`, `bindingKinds`, `reservedBindings`, `compute`). | `packages/core/src/stack-model.ts` |
| Requirement rows | `PORT_REQUIREMENTS` per (kind, role, capability, purpose, feature); validation derives per-function grants and bindings. Provider neutral in shape. | `packages/core/src/stack-requirements.ts` |
| Standalone platform | Node server, in-process cron, a Docker image (non-root Node 22). Reusable as the Cloud Run container base. | `packages/platforms/standalone` |
| Cron table | `CRON_JOBS` (staged-recovery, bundle-cleanup, archive-planner, retention, erasure-worker) with a `CronHandler(name, firedAt)`; the ARCHITECTURE text already names Cloud Scheduler as a trigger. | `core/src/stack-model.ts`, `cron.ts` |
| Terraform generator | Pure generator composing hand-written modules; provider block rendering. | `packages/infra-gen` |
| Cost model | A planned-GCP row (Cloud Run, Firestore Standard, Pub/Sub, GCS), roughly $13 per million events at Example scale, with the design constraint "Firestore sustains about 1 write per second per document". | `.agents-docs/COST_ESTIMATE.md` |
| Archive tier | M4 DuckDB engine and Iceberg REST client (catalog-agnostic). | `packages/adapters/archive-iceberg` |

### 1.2 What is AWS-specific today

Seen on `main`; the G5 audit must list every site (M4i is changing several of these files, so the audit waits for its merge).

- `core/src/stack-validation.ts`: `platform.manifest.id === "aws-lambda"` branches for deployment-view construction (ingest `rateLimit`
  env binding, platform bindings), the default `recordMode` (grouped only for `aws-lambda` plus `queue-sqs`), and the
  Lambda queue-DLQ `maxReceiveCount` floor (`CONSUMER_MAX_MISSING_ATTEMPTS`); the provider check requiring a region for `hashicorp/aws`.
- `core/src/stack-model.ts`: `EnvironmentFeature` includes `"aws-credentials"`; `FunctionSettings.architecture`
  (`x86_64` | `arm64`) and `QueueTriggerSettings` (`batchSize`, `maxConcurrency`, `visibilityTimeoutSec`, `dlq.maxReceiveCount`) are
  SQS-shaped; `PlatformManifest.authorization: "iam" | "bindings" | "none"` and capability policy outputs are IAM policy
  documents (resource ARNs plus actions).
- `core/src/deployed-runtime.ts`, `deployed-execution.ts`: AWS secret source, credential delivery.
- `packages/infra-gen`: `MIN_AWS` minimum version, and `region` / `tags` on a non-`aws` provider are rejected ("not implemented"); the generated provider block has no `project` or `labels` notion.
- `packages/cli`: `aws-credentials.ts`, ZIP packaging (`build.ts`), the `--remote` bootstrap invokes Lambda.
- `packages/terraform-modules` ships only `aws`; `infra/modules/aws/output-shapes.json` pins module output shapes.
- `packages/aws-signing` (SigV4) has no GCP analogue yet: GCP needs OAuth access tokens, ID tokens and optionally `signBlob`.
- Docs: ARCHITECTURE.md lists `store-firestore`, `queue-pubsub`, `blob-gcs`, `platforms/cloud-run` as M7+ and says "GCS interop" is covered by `blob-s3`.

### 1.3 Findings from research that shape the plan

Sources are listed in section 9. The load-bearing ones:

- Firestore document limit is 1 MiB (field value 1,048,487 bytes), index entries per document 40,000, composite indexes 200 per database (1,000 with billing), transactions last at most 270 s with a 60 s idle expiry, TTL deletes typically land within 24 hours and are unordered. The quotas page states no per-document write rate. The best-practices page says the maximum "depends highly on the workload", warns about hotspots from sequential indexed fields (a collection with an indexed sequential field is capped at about 500 writes per second), and recommends exempting unqueried sequential fields from indexing. COST_ESTIMATE's "about 1 write per second per document" is therefore an operating assumption to load-test, not a documented guarantee.
- The Firestore emulator does not track composite indexes (any valid query runs), uses simple locking (concurrent writes to one document can wait up to 30 s) and does not enforce every production limit. Index correctness cannot be proved offline; it needs a generated-index coverage test plus real Firestore.
- Pub/Sub push: one HTTP request per message; 102/200/201/202/204 acknowledge, anything else is a nack; the ack deadline of a push subscription cannot be changed per message; push backoff (100 ms to 60 s, exponential) is applied subscription-wide and combines with the retry policy (the larger delay wins). With message ordering "only one outstanding message per ordering key" is delivered, and a redelivery redelivers all later messages of that key; dead-letter delivery is best effort and may break order. Publishers must publish a given ordering key to one region. Dead-letter `max_delivery_attempts` is 5 to 100 (default 5) and is approximate; the push body carries `deliveryAttempt` only when a dead-letter policy exists. Message data up to 10 MB, 100 attributes (value 1 KiB), publish request up to 1,000 messages and 10 MB. The emulator supports push (plain http), ordering, dead-lettering and retry policies, but does not say whether it sends OIDC tokens and does not support IAM operations.
- Pub/Sub OIDC: the push subscription names a service account and an optional audience; the Pub/Sub service agent needs `roles/iam.serviceAccountTokenCreator` on that account; Cloud Run verifies the token itself when the push account holds `roles/run.invoker` on the service. Tokens on push requests can be up to an hour old.
- Cloud Run: request timeout up to 60 minutes, up to 1,000 concurrent requests per instance, 32 MiB HTTP/1 request size, 32 GiB / 8 vCPU per instance. Tokens come from the metadata server (`.../instance/service-accounts/default/token`, `.../identity?audience=`); a user-managed service account per service is recommended; never set `GOOGLE_APPLICATION_CREDENTIALS` on Cloud Run. Cloud Scheduler calls Cloud Run with an OIDC token from a service account holding `roles/run.invoker`; the audience defaults to the full URL including parameters, so set it to the bare service URL.
- GCS: single-request (multipart) upload for small objects, resumable for large or unknown size (Terraform switches at 16 MiB); `ifGenerationMatch=0` succeeds only if no live object exists (412 otherwise), generation preconditions also apply to deletes; signed URLs last at most 7 days. The `signBlob` details were not on the fetched page (to verify in G1).
- Cloud SQL IAM authentication: service-account user name is the email without `.gserviceaccount.com`; roles `roles/cloudsql.instanceUser` (login) and `roles/cloudsql.client` (connect through the proxy or connector); the password is an OAuth 2.0 access token; the Node.js connector and Auth Proxy v2 can do this automatically. From Cloud Run: unix socket `/cloudsql/<connection name>` (public IP, built-in proxy, encrypted) or TCP to the private IP over Direct VPC egress or a Serverless VPC Access connector. Each Cloud Run instance can open up to 100 connections. Direct VPC egress needs a /26 or larger subnet, about 2x instances in addresses, may add 30 s or more to cold starts when combined with Cloud NAT, and caps at 1 Gbps per instance.
- Terraform: the `google` provider is at 8.0 (GA announcement; 7.x lines reached at least 7.17). HashiCorp recommends upgrading to the latest 7.x and clearing deprecations before 8.0. The 8.0 upgrade guide was not read (G6 task).

## 2. Slice plan

Rules for every slice (CLAUDE.md): contract suite first; default `pnpm test` offline with no daemons or credentials; opt-in emulator tests that skip when the service is absent (suggested switches `ERRTRAQ_FIRESTORE_EMULATOR`, `ERRTRAQ_PUBSUB_EMULATOR`, `ERRTRAQ_GCS_EMULATOR`, or detection of the standard `FIRESTORE_EMULATOR_HOST`, `PUBSUB_EMULATOR_HOST`, `STORAGE_EMULATOR_HOST` variables); `core` and `http` stay free of `node:*` and cloud SDKs; the standard gate (`typecheck`, `lint`, `test`); one `TODO(Gn)` comment where a later slice plugs in; no `terraform apply`. Do exactly the slice.

```
G0 -> G1 ----------------\
G0 -> G2 ----------------+-> G5 (needs M4i) -> G7 -> G8
G0 -> G3 -> G3b ---------+        ^
G0 -> G4 --------------+        |
G6 (HCL modules) ---------+-------+
```

Can start before M4i merges: G0, G1, G2, G3, G3b, G4, G6 (HCL only), the emulator harness of each. They touch only new adapter packages, `packages/testing` (additive), `packages/adapters/store-sql` (G4) and `infra/modules/gcp`. Must wait for M4i: G5 and anything that edits `core/src/stack-*.ts`, `core/src/deployed-*.ts`, `core/src/runtime.ts`, `packages/infra-gen` provider handling or `packages/cli`. G7 and G8 follow G5 and G6. One caveat for the early slices: their `stack.ts` files import core types (`InfraDescriptor`, `TopicMapping`); M4i may adjust `stack-model.ts`, so merge or rebase against it before merging a G slice, and keep descriptor-shape assumptions in one small file per adapter.

### G0. `gcp-auth` package (new, no core change)

- Status (2026-11-26): implemented on branch `g0-g1`, review by Claude Opus pending. `TokenSource` (metadata server, service account key, static, none), `IamSigner` and a local key signer (`BlobSigner`), `verifyGoogleIdToken` with a cached JWKS store for G2, `createCredentials` resolver. Contract and unit tests are offline (39 tests).

- Goal: one Workers-safe, fetch-only credential layer for every GCP adapter, the analogue of `packages/aws-signing`.
- Scope: new `packages/gcp-auth`: `TokenSource` with `getAccessToken(scopes)` and `getIdToken(audience)`; providers in resolution order: explicit static token (tests), emulator (`none`), service-account key JSON signed with WebCrypto RS256 (non-GCP hosts such as the standalone container and CI), metadata server (`http://metadata.google.internal/computeMetadata/v1/...`, header `Metadata-Flavor: Google`; also `GCE_METADATA_HOST` override). Token cache with an expiry skew and single-flight refresh; `signBlob` helper through the IAM Credentials API (for GCS V4 signed URLs); no `node:*` (the metadata server and key file are reached through injected `fetch` and a key string, never `fs`); no `google-auth-library`.
- Contract first: a `TokenSource` contract (cache reuse, refresh before expiry, concurrent refresh coalesced, failure not cached, scope keying) run against a fake metadata server (a `fetch` stub) and the JWT signer against a fixed test key.
- Tests: offline only; unit tests for the JWT claim set and PEM import; no real Google call.
- Done: contract passes, layering check passes, export surface documented.

### G1. `blob-gcs` adapter

- Status (2026-11-26): implemented on branch `g0-g1`, review by Claude Opus pending. `blobStoreContract` is green against a fetch fake offline and against `fake-gcs-server` 1.56.1 (opt-in, `pnpm test:gcs-emulated`, `ERRTRAQ_GCS_EMULATOR`). The put path is a simple media upload (not multipart, no object metadata beyond the content type is needed) and resumable for streams. The `gcp/gcs` module is not written yet (`TODO(G6)`). Spike results are in JOURNAL 2026-11-26 (G0/G1).

- Goal: `BlobStore` over the GCS JSON API, passing `blobStoreContract`.
- Scope: new `packages/adapters/blob-gcs` (`manifest`, `create`, `infra`, `gcsBlob()` selection, `runtime` subpath). Operations: `put` (multipart for bodies up to a threshold, resumable for streams and unknown size; honour `size` metadata; `Content-Type`), `get` (`alt=media`, `Range` header; missing key gives `null` on 404; corrupt data raises `BlobCorruptError` using the object's crc32c/md5 when a full read), `head` (object metadata), `list` (`prefix`, `maxResults` up to 1000, `pageToken` as the opaque cursor; order is already lexicographic UTF-8, matching the port), `delete` (404 is success), `presign` (V4 signed URL via `signBlob`, GET and PUT, at most 7 days). Key validation reuses the shared blob key rules. Retry policy for 408/429/5xx with jitter and idempotency awareness (`ifGenerationMatch` makes resumable and multipart creates retry-safe where the port needs it). Config: `bucket`, `endpoint` override (emulator), `requestTimeoutMs`, `overallTimeoutMs`, auth mode.
- Port changes: none expected. Question to settle in the contract first: whether `put` must be an unconditional overwrite (it is for S3). GCS overwrites by default, so this matches; no `ifGenerationMatch` is needed except for any future create-only API.
- Contract first: extend `blobStoreContract` only where GCS exposes a gap (listing across page boundaries with more than 1000 keys, range read at the end of the object, zero-byte object, key at 1024 UTF-8 bytes, delete of an absent key, overwrite while a read is open).
- Tests: offline unit tests with a fetch stub for request shapes (URL encoding of object names, resumable session handling, paging); opt-in contract run against an emulator (see D6). The emulator must be spiked first for `ifGenerationMatch`, resumable uploads and list paging; fall back to the other candidate or to real GCS in G8.
- Infra descriptor: module `gcp/gcs` (bucket, uniform bucket-level access, public access prevention enforced, lifecycle rules for `staged/` and `artifacts/chunks/` like the S3 module, versioning off, soft delete policy left to the operator but documented because soft-deleted bytes count as PII copies for erasure). Capability policies `read`, `write`, `delete`, `list` become IAM binding documents (section 5).
- Done: `blobStoreContract` green against the emulator, bundles under the Workers check, descriptor snapshot test.

### G2. `queue-pubsub` adapter

- Goal: `Queue` over Pub/Sub with a push source, passing `queueContract`.
- Scope: new `packages/adapters/queue-pubsub`. Producer: REST `topics/{topic}:publish` (batch up to 1,000 messages, 10 MB; split larger), body base64 JSON `{key, body}`, attributes `errtraq-topic` and `errtraq-key`, `groupKey` as `orderingKey` (1 KB limit; hashing for longer keys), regional endpoint when ordering is used. Push source `handle(event, handler)`: the event is the HTTP request (method, headers, JSON body `{message:{data,attributes,messageId,publishTime,orderingKey}, subscription, deliveryAttempt}`); it decodes into one `Delivery` (`id` = `messageId`, `attempt` = `deliveryAttempt` or 1) and returns the status: 204 on `ack`, 503 on `retry`. Unknown topic attribute or malformed body is acknowledged only if it can never succeed (the SQS policy for unknown topics applies), otherwise nacked. Capabilities: `delivery: "push"`, `maxBytes` 10 MB minus the envelope overhead (claim-check keeps real messages tiny), `delay: false`, `dlq: true`, `grouping: "per-key-serial"` for the `record` physical queue (needs `enable_message_ordering` on its subscription) and `none` for the others, `physicalQueues` as in SQS.
- Mapping decisions (section 4): `retry.delaySec` cannot be honoured per message (the subscription retry policy and push backoff decide), so `delay: false`; the port already allows that for FIFO SQS and no core path calls producer `delaySec` today (verified by grep, to re-check in the slice).
- Config: `mode` (`shared` | `per-topic`, as SQS), `ackDeadlineSec` (the visibility analogue; validation requires six consumer timeouts, section 4.4), `minBackoffSec` / `maxBackoffSec`, `dlq`, `maxDeliveryAttempts` (5 to 100), `endpoint` override, regional endpoint option.
- Contract first: extend `queueContract` with push-source cases the memory fake can express (ack, retry, partial result for a one-delivery batch, redelivery increments `attempt`, per-key order is preserved while an earlier delivery is outstanding, unknown topic never acknowledged blindly). A recorded-fixture test set for the real push body, in the style of the AWS captures (`aws-captures.test.ts`), hand-written from the documented JSON first, replaced by scrubbed real captures in G8.
- Tests: offline unit tests (producer request shapes, push decoding, status mapping, batching split); opt-in contract run against the Pub/Sub emulator (publish, a local HTTP receiver as push endpoint, ordering key serialization, dead-letter after `max_delivery_attempts`). OIDC cannot be exercised on the emulator (not documented), so token handling is tested at the platform layer with synthetic JWTs.
- Infra descriptor: module `gcp/pubsub` (topics, dead-letter topics with a retaining pull subscription so dead letters are not lost, `publisher` policies per physical queue). Subscriptions live in the platform module (section 5.3).
- Done: contract and fixture tests green, emulator run green, descriptor snapshot.

### G3. `store-firestore` adapter

- Goal: `ActiveStore` on Firestore (native mode), passing `activeStoreContract`. Design in section 3.
- Scope: new `packages/adapters/store-firestore`: `keys.ts` (document paths and encodings), a minimal Firestore REST client (`documents:commit`, `beginTransaction`, `batchGet`, `runQuery`, `listCollectionIds` not needed; structured value encoding; transaction retry on `ABORTED`; `RESOURCE_EXHAUSTED` and `UNAVAILABLE` backoff; per-request timeouts), `projects.ts`, `issues.ts`, `events.ts`, `releases.ts`, `meta.ts`, `record-event.ts` (single and grouped `recordEvents`), `indexes.ts` (the declarative composite-index list that both the infra module and an offline test consume), `stack.ts`. Capabilities declared in the manifest: `deleteStrategy: "explicit"`, `textSearch: false`, `lastSeenRangeOnOtherSort: false`, `recordEvents: true`.
- Port changes: none. A capability for the inline payload limit is needed only if core's overflow threshold is not already adapter-configurable (check `core` before G3 starts; a one-line port addition lands first if so).
- Contract first: run the existing `activeStoreContract` first; add cases for what Firestore makes different: listing consistency is strong (no GSI lag) so keep tests tolerant; event ids with `/`, `.`, `__x__` patterns and 1,500-byte ids (path-segment encoding); more than 500 documents in a bundle debug-id write; item at the 1 MiB boundary rejected, never truncated; concurrent `recordEvent` on one issue gives an exact count.
- Tests: offline unit tests for key encoding, value encoding round trips, cursor encoding, size guard, query construction against a recorded-request fake; the index-coverage test (every query shape the adapter can issue maps to an entry in `indexes.ts`, because the emulator will not tell you); opt-in contract run against the Firestore emulator with generous transaction timeouts.
- Infra descriptor: module `gcp/firestore` (database in native mode, location, delete protection from the stack `protection`, composite indexes from `indexes.ts`, single-field exemptions for payload and sequential fields, TTL policies for KV). Capability policies per section 5.
- Done: contract suite green on the emulator, index coverage test green, descriptor snapshot, size guard test.

### G3b. KV on Firestore (`kv-firestore`)

- Goal: `KV` backing for rate limits, DSN-key cache and erasure suppression.
- Scope: new package (or a subpath of `store-firestore`; prefer a separate package mirroring `kv-dynamodb`). `increment` through a `commit` with a field transform (`increment`) where the transform result (`transformResults`) gives the new value, to be verified; a transaction when the document must be created with a TTL, since "TTL applies on creation" needs an existence check. Counters stored as an integer field distinct from the string `put/get` value so the "existing value must be a safe integer, otherwise `InvalidCounterError`" rule is checkable. `expireAt` timestamp plus a Firestore TTL policy; reads compare `expireAt` to the clock because TTL deletion lags up to 24 hours.
- Contract first: the existing KV contract plus: expired but not yet deleted key reads as absent; increment after expiry restarts; concurrent increments sum exactly; value of the wrong type raises `InvalidCounterError`.
- Tests: offline unit tests; opt-in emulator run; a measured hot-key probe in G8 (D5).
- Done: contract green, descriptor snapshot, hot-key limits written into the adapter README text and JOURNAL.

### G4. Cloud SQL for PostgreSQL wiring

- Goal: `postgres({ mode: "cloudsql-iam", ... })`, the Cloud SQL analogue of the RDS IAM path; the dialect and `store-sql` schema are unchanged.
- Scope: `packages/adapters/store-sql/src`: a new pool configuration `cloudSqlIamPoolConfig` (password supplier calling the G0 token source with the Cloud SQL login scope, token cached with skew and fetched per new connection, pool `max` kept low because each Cloud Run instance may open at most 100 connections, `idleTimeoutMillis` below token lifetime); a new schema branch in `postgres-stack.ts` (fields: `instanceConnectionName`, `database`, `user` = service account email without `.gserviceaccount.com`, `connection: { kind: "unix-socket" } | { kind: "tcp", host, port, serverCa }`); TLS handling for the TCP form (see D9); administrator provisioning reuses `postgres-admin.ts` with the `GRANT rds_iam` statement parameterised away (a Cloud SQL IAM service account user is created by Terraform, so `provisionIamUser` only grants schema and table privileges), admin secret in Secret Manager; a `gcp/cloudsql-iam-access` HCL module (outputs the binding documents `roles/cloudsql.instanceUser` and `roles/cloudsql.client` on the project or instance, per capability like `rds-iam-access`). Same shared-user caveat as RDS: IAM authenticates the connection, SQL privileges decide read, write, delete.
- Contract first: reuse the postgres integration suite (`postgres.integration.test.ts`); add pool-config unit tests (token supplier called per connection, never logged, expiry skew, refresh failure surfaces a scrubbed error).
- Tests: offline unit tests for pool config and the stack descriptor; the opt-in Postgres suite already runs against a local server and stays valid (IAM is a transport concern). Real IAM login is G8.
- Done: unit tests and descriptor snapshot green, the existing postgres suites unchanged.
- Status (2026-11-26, branch `g4`): implemented in `packages/adapters/store-sql/src/postgres-cloudsql.ts` (plus the `cloudsql-iam` branches of `postgres-stack.ts`, `postgres.ts` and the `flavor` option of `postgres-admin.ts`); offline tests in `postgres-cloudsql.test.ts`; opt-in socket run in `scripts/test-postgres-cloudsql.mjs`. Deviations from the scope text above: the config takes `serviceAccountEmail` (the database user is derived) and may omit it so each function derives its user from its own identity; the token source arrives as the `accessToken` binding function (and optional `serviceAccountEmail` function), wired by G5 (`TODO(G5)`); `serverCa` is the PEM carried inline, not a path; `serverName` selects hostname verification for shared and customer-managed server CAs. The `gcp/cloudsql-iam-access` HCL module is `TODO(G6)`. Findings for G5 and G6: the user of a Cloud SQL IAM identity is one per service account while the plan gives one service account per function, so SQL grants must exist for every function account (the admin bootstrap grants one user today); core checks that a provider source ends in `/<module.provider>`, so `module.provider` `gcp` cannot validate against `hashicorp/google` (G5 must map the family or the modules must live under `infra/modules/google`).

### G5. Core, platform and CLI wiring (`platforms/cloud-run`) (waits for M4i)

- Goal: a stack that selects `cloudRun()` plus Firestore or Cloud SQL, Pub/Sub, GCS and a KV generates, validates and builds.
- Scope:
  - `packages/core` (after M4i): make the AWS-specific branches in section 1.2 platform-driven (platform manifest declares: default record mode, DLQ minimum attempts, supported settings keys, binding delivery) instead of `id === "aws-lambda"` tests; add `"gcp-credentials"` (or a generic `"ambient-credentials"`) to `EnvironmentFeature`; widen `QueueTriggerSettings` with provider-neutral `ackDeadlineSec` mapping onto `visibilityTimeoutSec`; add the `authorization` style for GCP bindings documents. Requirement rows and the `archive` role stay as M4i defines them.
  - `packages/platforms/cloud-run`: `manifest` (`runtime: "node"`, `compute: "function"`, binding kinds env, secret and platform, `authorization` GCP style, `provides` ambient credentials), config schema (`roles`, `split`, `http`, per-role `settings`: `memoryMb`, `cpu`, `timeoutSec`, `concurrency`, `minInstances`, `maxInstances`, `ingress`, `vpcEgress`), `handler.ts` (an HTTP server entry on `PORT`, reusing the Hono apps; internal routes `POST /_errtraq/push/<physical>` (Pub/Sub push to `Queue.push.handle`), `POST /_errtraq/cron/<job>` (Scheduler to `CronHandler`), health route), a GCP `SecretSource` over Secret Manager REST (`versions/latest:access`, scrubbed errors, like `secrets.ts`), and `bootstrap` as a Cloud Run job or a private authenticated service invoked with an ID token (`errtraq bootstrap --remote` signs with G0).
  - `packages/cli`: container build output (one Dockerfile and bundle per physical function, base image the standalone Node 22 image lineage, non-root, `PORT`), image reference as a stack variable (digest pinned), GCP credential resolution for operator commands (application default credentials or a key file) in the CLI only.
  - `packages/infra-gen`: provider support for `hashicorp/google` (`project`, `region`, `default_labels`; the "not implemented" rejection removed for it), a version floor constant analogous to `MIN_AWS`.
- Contract first: platform handler tests with the shared pipeline fixtures (push body fixtures from G2, Scheduler request fixtures), stack-validation negative tests (pull-only queue with Cloud Run is fine because it is a container, but NATS pull with a function role is still rejected as before; Pub/Sub with `mode` mismatches; ack deadline below six consumer timeouts; `record` role without ordering).
- Tests: offline only (handler, validation, build manifest, infra-gen snapshots, `terraform validate` on the generated root once G6 exists).
- Done: `stacks/gcp-firestore.ts` and `stacks/gcp-cloudsql.ts` generate and validate; handler tests green; `pnpm typecheck && pnpm lint && pnpm test` clean.

### G6. Terraform modules `infra/modules/gcp/*` and `packages/terraform-modules/gcp`

- Goal: HCL for every `infra` descriptor, plus the platform module. Can start before M4i because it is HCL, module `variables.tf` contracts and Terraform tests only; module output shapes are pinned in a `gcp/output-shapes.json` like AWS.
- Modules:
  - `cloud-run-app`: one `google_service_account` per physical function, `google_cloud_run_v2_service` per function (image, env, secret references not used, `ingress`, `max_instance_request_concurrency`, `timeout`, scaling, VPC access block), `run.invoker` for `allUsers` on HTTP ingest and API (the app authenticates DSN keys and tokens, same posture as Lambda URL `NONE`) and for the push and scheduler identities on the rest, Pub/Sub push subscriptions (OIDC token with the push service account and the bare service URL as audience, `ack_deadline_seconds`, `retry_policy`, `dead_letter_policy`, `enable_message_ordering` for `record`), Scheduler jobs for `CRON_JOBS` (UTC, retry config, OIDC), Secret Manager accessor bindings per `secretReads`, IAM bindings from the derived policy documents, log-based alert placeholders mirroring the AWS alarms.
  - `pubsub`, `gcs`, `firestore`, `cloudsql-iam-access` as above, plus an optional `cloudsql` convenience is deliberately not provided (existing instance, like the RDS path).
  - `artifact-registry` is optional and operator-owned by default (D12).
- Tests: the existing pattern of `terraform test` files under each module's `tests/` (mock providers), the security-contract and mutation tests re-pointed at the GCP binding documents, `terraform validate` in CI. No `terraform apply` by agents.
- Provider pin: read the 8.0 upgrade guide, then choose the floor (D11).
- Done: every module validates and its tests pass; output shapes recorded; packaging includes `gcp` in `terraform-modules`.

### G7. Example stacks and the emulated suite

- Goal: runnable examples and an emulator-backed regression harness.
- Scope: `stacks/gcp-firestore.ts`, `stacks/gcp-cloudsql.ts`, a per-topic variant; generation snapshots in `infra-gen`; `scripts/gcp-emulated/` mirroring `scripts/aws-emulated` (starts the three emulators on free ports, sets the standard `*_EMULATOR_HOST` variables, runs the contract suites and the standalone end-to-end with `@sentry/node` against a Cloud Run handler process, skips with a clear message when an emulator binary or image is missing); `errtraq dev` can already run the standalone platform with fs blobs for local development, so no GCP emulation is required for the default developer loop. A `WINTERBAUME_GAPS.md` style note records what the GCP emulators cannot check (indexes, IAM, OIDC, quotas).
- Tests: default suite offline; opt-in `pnpm gcp-emulator` suite.
- Done: snapshots green, emulated suite passes where the emulators allow, gaps documented.

### G8. Real GCP verification (operator-run)

- Goal: parity with M3h for GCP. Needs a real project (D8); agents never apply.
- Checks: Firestore index creation time and `FAILED_PRECONDITION` behaviour for missing indexes (generated list is complete), hot-issue and hot-DSN-key contention (`recordEvent` and `increment`), transaction abort and retry rates, payload at the 1 MiB boundary, TTL deletion lag; Pub/Sub push with OIDC end to end (Cloud Run verification, audience, token age), per-key ordering and redelivery order after a nack, dead-letter delivery and `deliveryAttempt`, ack deadline behaviour with the six-times rule, regional endpoint requirement, scrubbed real push captures replacing the hand-written fixtures; GCS conditional writes, resumable upload, list paging above 1000, signed URLs via `signBlob`; Cloud SQL IAM login from Cloud Run over the unix socket and over private IP, token expiry during a long-lived pool; Cloud Scheduler to cron; cold start of each role; least-privilege IAM (list the permissions actually used and tighten the custom roles); cost sample against COST_ESTIMATE.
- Done: JOURNAL entry with measurements, TODO updates, destroy inventory clean.

### Later (not in this plan's slices)

- Archive tier on GCP. DuckDB runs on Cloud Run (M4 D1) so the engine is reusable. Candidate catalog: the BigLake metastore Iceberg REST catalog (endpoint `https://biglake.googleapis.com/iceberg/v1/restcatalog`, GCS backed, DuckDB documents attaching it with an access token and a billing-project header, Google documents credential vending). Open questions for a later slice: format v3 and deletion-vector support in BigLake (M4 D3 chose v3 from the start), DuckDB write access through that catalog (the doc snippet is read oriented), and whether `iceberg_use_metadata_log` and commit-conflict behaviour match. The alternative is the self-hosted Lakekeeper on Cloud Run with a Cloud SQL backend. Do not start before M4m shows the AWS path working. The M4 `archive` role needs a container image, which G5's image pipeline already provides.
- Cloud Tasks queue, Memorystore KV (D5), Workload Identity Federation for non-GCP callers, Firestore Enterprise edition, VPC Service Controls, multi-region Firestore.

## 3. Firestore data model

Native mode, Standard edition, one database per stack. Rationale for shape: Firestore queries are strongly consistent and served from automatic single-field indexes plus declared composite indexes, so the DynamoDB machinery (sparse keys-only GSIs, exact count-sort keys, eventual-consistency hydration, project-time shards) is not needed. What is needed instead is care for the 1 MiB document, hotspot behaviour, index declaration, and the fact that the emulator does not enforce indexes.

### 3.1 Layout

All ids are encoded to Firestore-legal path segments (no `/`, not `.` or `..`, not matching `__.*__`, at most 1,500 bytes): ids that are already URL-safe (hex event ids, decimal project ids, issue ids derived by core) are used as is; free-form natural keys (slugs, versions, public keys) go through a prefix-safe percent-style encoding, and long components are replaced by a domain-separated SHA-256 with the original stored in a field and verified on read (same rule as `DYNAMODB_DESIGN.md`).

| Port data | Path | Notes |
|---|---|---|
| Table metadata | `meta/schema` | schema version; `migrate()` creates or verifies it (create precondition `exists=false`) |
| Organization | `orgs/{orgId}` | |
| Project | `projects/{projectId}` | fields include `orgId`; `listByOrg` is one query `orgId == x` ordered by name `__name__` |
| Natural-key markers | `markers/{kind}|{hash}` | org slug, (org, project slug), token hash, (project, release version), public key id, debug id; created with `exists=false` in the same transaction as their owner; the existing owner passes, another owner gets `ConflictError`; rename deletes the old marker transactionally |
| DSN key | `keys/{publicKey}` | `getKey` is one `get` (ingest `key-read`); project key list is a query `projectId ==` |
| API token | `tokens/{tokenHash}` | `createToken` is create-only (never revives); `listTokens` per org, `revokeToken` an idempotent update |
| Issue | `projects/{projectId}/issues/{issueId}` | issue ids minted by core (scattered hashes, hotspot safe) |
| Issue pointer | `issueIds/{issueId}` with `{projectId}` | created in the same transaction as the issue; `issues.getById` reads it strongly then the issue, no collection-group index |
| Event | `projects/{projectId}/events/{eventId}` | event ids are 32-char random hex, scattered |
| Release | `projects/{projectId}/releases/{releaseId}` | |
| Bundle | `projects/{projectId}/bundles/{bundleId}` | state `pending` / `active`, `expiresAt`, cleanup claim fields, manifest blob reference |
| Debug-id marker | `markers/debug|{projectId}|{hash}` | exclusive ownership, written with the bundle in one commit (at most 100 ids plus the bundle doc, within one commit) |
| Archive state | `meta/archive|{projectId}` | `version`, `ArchiveState` body |
| Erasure request | `erasure/{erasureId}` | fields `projectId`, `state`, `version`; indexes for the four list filters |
| KV | `kv/{encodedKey}` | `v` (string), `n` (integer counter), `expireAt` (timestamp, TTL policy) |

Using per-project subcollections keeps one project's data and index entries physically separate and makes project deletion a recursive delete per subcollection; cross-project reads (`getById`, key lookup, token lookup) use the explicit pointer and top-level documents, never collection-group queries, so no collection-group index is needed.

### 3.2 Repositories

- `recordEvent(o, e)`: one transaction (`beginTransaction` with `readWrite`): `get` the event document and the issue document (batched), return `inserted: false` with the current issue if the event exists; otherwise create the event (`exists=false`), create or update the issue (`count += 1`, `lastSeen`, `lastEventId` or `latestEvent` pointer, status and regression decision computed from the read value, `firstSeen` on creation) and, for a new issue, the `issueIds` pointer. The regression decision is correct because the read is inside the transaction and Firestore server-side transactions use pessimistic locking on the documents read, so two writers of one issue serialize; an `ABORTED` result retries with jittered backoff, bounded by an overall deadline. Atomicity of `IssueRepo.recordOccurrence` is exactly this transaction. Idempotency on `(projectId, eventId)` is the existence check; the DynamoDB limitation (a redelivery after the event was deleted is counted again) applies unchanged and is documented the same way.
- Grouped `recordEvents(batch)` (capability `recordEvents: true`): one transaction for events of one issue (core already groups by issue in the `record` stage): one read of the issue, N event creates (existing ones skipped), one issue update with `count += inserted`. At most 500 writes per commit is the conservative planning limit (the quotas page fetched did not state a write count, to verify); larger groups split into several transactions, each one a valid atomic step.
- `issues.list(q)`: `projects/{p}/issues` with `where status == s` (when given), optional `lastSeen` half-open range `[from, to)` (only for the `lastSeen` sort, see capabilities), `orderBy(sortField desc)` then `orderBy(__name__ asc)` to keep ties in ascending issue id order (the same tie rule as SQL and DynamoDB), cursor `startAfter(sortValue, issueId)`. Status-less listing needs no merge of three partitions: it is one query without the equality filter. Counts are exact and cheap: `count` is a plain integer field updated in the issue transaction, so no count-guard or complemented-key trick.
- `events.listByIssue(q)`: `where issueId == i`, `orderBy(receivedAt asc|desc)`, `orderBy(__name__ asc|desc)` (the port's `(receivedAt, eventId)` keyset in either direction), half-open `from`/`to`, cursor `startAfter(receivedAt, eventId)` matching the `after` boundary; the page cursor records the last examined key so empty pages still progress, as the contract requires. Per-project subcollection, so the project filter is implicit.
- `scanOlderThan(projectId, cutoff, {cursor, limit})`: `where receivedAt < cutoff`, `orderBy(receivedAt asc)`, `orderBy(__name__ asc)`, same cursor shape; the archival worker's source. Single-field index only; `deleteBatch` uses commits of at most 500 deletes (`deleteStrategy: "explicit"`). A `ttl` strategy is not built (M4 D14 defers it); Firestore TTL deletes are unordered and delayed up to a day, so the same data-loss warning applies and the capability stays `explicit`.
- `projects`, `releases`, `bundles`, markers: natural-key uniqueness through marker documents in transactions, as above. Pending-bundle listing is `bundles where state == pending, orderBy expiresAt`; `claimPendingBundleCleanup` is a transaction that moves the claim; `verifyAndActivateBundle` re-reads the markers in a transaction before flipping state. Pending bundle documents and manifest chunks carry no TTL (owner decision, TODO) and the `bundle-cleanup` cron stays mandatory.
- `meta` (`MetaRepo`): compare-and-set on `version`. Implemented as a transaction (read, compare `version`, write `version + 1`, `ConflictError` otherwise); a write with an `updateTime` precondition is the cheaper alternative if profiling shows the read cost. Creation at version 0 is create-only.
- `migrate()`: creates `meta/schema`, verifies the schema version, and does not create indexes (the data plane cannot; indexes come from Terraform, G6). The first query against a missing index fails with `FAILED_PRECONDITION`; the adapter surfaces it as a clear configuration error naming the missing index definition from `indexes.ts`.

### 3.3 Composite and single-field indexes

Declared once in `indexes.ts` and rendered into the `google_firestore_index` resources. Collection scope; per-project subcollections use the collection-group-less scope `COLLECTION` with the id `issues` or `events`.

| Query | Index |
|---|---|
| Issues by status, sort `lastSeen` | `issues`: `status ASC, lastSeen DESC, __name__ ASC` |
| Issues by status, sort `firstSeen` | `status ASC, firstSeen DESC, __name__ ASC` |
| Issues by status, sort `count` | `status ASC, count DESC, __name__ ASC` |
| Issues without status | single-field index on `lastSeen`, `firstSeen`, `count` (descending served by the automatic index; the `__name__ ASC` tie order may need explicit composites, to verify on real Firestore) |
| Issues by `lastSeen` range with status | covered by the `lastSeen` composite above |
| Events by issue and time | `events`: `issueId ASC, receivedAt ASC, __name__ ASC` and the descending twin |
| Archival scan | single-field `receivedAt` (ascending) plus `__name__` |
| Erasure lists | four composites over (`projectId`, `state`, `requestedAt`) per the existing filter combinations |
| Bundles pending | `state ASC, expiresAt ASC` |
| Projects by org, keys by project, tokens by org | one equality field plus `__name__` |

The count of composites stays far below 200. `lastSeenRangeOnOtherSort` is declared `false`: Firestore requires the first `orderBy` to be the inequality field, so a `lastSeen` range with a `count` sort is rejected through `capabilities` ("not supported by this store") rather than scanned, as CLAUDE.md requires. `textSearch` is `false`.

Index exemptions (single-field): the payload field, any raw JSON blob and manifest chunk fields are exempt from indexing (indexed strings over 1,500 bytes are truncated and can produce inconsistent query results, and index entries have a 7.5 KiB cap); `receivedAt` on `events` stays indexed because the archival scan and event lists need it, but this is a sequential indexed field, and the best-practices page caps such a collection at about 500 writes per second. Per-project subcollections divide that across projects, and the expected event rate (about 12 events per second overall at 1 M per day, DYNAMODB_DESIGN) sits well below it; G8 measures it, and a day-bucketed `receivedDay` field plus an index on it is the fallback if one project exceeds the cap.

### 3.4 Payload size and overflow

Core overflows event payloads to `BlobStore` at 200,000 raw bytes. The Firestore document limit is 1 MiB for the whole document (name 6 KiB, field value up to 1,048,487 bytes), plus index entries are counted separately (40,000 entries, 8 MiB per document). The payload is stored as a compressed `bytes` field (gzip via `CompressionStream`, web standard), measured like DynamoDB's attribute. The adapter validates the final encoded size and rejects an oversized document clearly (never truncates), mirroring the DynamoDB item-size guard. If a lower or higher inline limit is wanted, the existing overflow threshold must be adapter-configurable; check before G3.

### 3.5 Capabilities and KV hot keys

- `capabilities`: `{ textSearch: false, lastSeenRangeOnOtherSort: false, recordEvents: true }`; `EventRepo.capabilities`: `deleteStrategy: "explicit"`, `deleteBySubject: false` until M4k.
- KV: per-document write throughput is the structural limit. Rate-limit keys are fixed-window counters (`rate-rejection.ts`: per-issue and per-project windows, per-event marker keys using `increment == 1` as the first-attempt signal) and the ingest DSN-key limiter (one counter per key per window). A hot key beyond roughly one sustained write per second per document will see contention, latency and aborted transactions (a documented class of problems, with no fixed number on the pages fetched). Mitigations in order: (1) `increment` as a commit field transform rather than read-modify-write, (2) window-keyed documents so each counter lives one window, (3) `onKvFailure: "allow"` (core already fails open and logs an aggregate), (4) a Memorystore for Redis KV adapter later (D5). Sharded counters are not offered for `increment` because the port returns the exact new value, which a sharded sum cannot do atomically; they would only suit a future approximate limiter.

## 4. Pub/Sub mapping to the Queue port

### 4.1 Topology

Physical queue = one topic plus one push subscription (plus one dead-letter topic with a retaining pull subscription when `dlq` is on). `mode: "shared"` yields topics `shared` (ingest, archive.project, notifications) and `record`; `per-topic` yields one per logical topic, as `queue-sqs`. The `record` physical queue has `enable_message_ordering = true`; others do not (ordering throttles push to one outstanding message per key and is wasted work for unordered topics). Producer binding `ERRTRAQ_QUEUE_<KEY>_TOPIC` carries the full topic resource name.

### 4.2 Delivery semantics

- Delivery is at-least-once; the handlers are already idempotent on `eventId` (`recordEvent`, `EventRepo.put`, grouped records). Exactly-once delivery is a pull feature, not used.
- A push request carries exactly one message, so `BatchHandler` receives a one-element batch (`batchSize` is not a setting). `ack` returns 204. `retry` returns 503; the next attempt is governed by the subscription retry policy and push backoff, never by `delaySec`, so `capabilities.delay = false` and a `retry` with `delaySec` is accepted but best effort (documented in the manifest capability text).
- Ordering: per-key serial via `orderingKey = groupKey` (issue id) on the `record` queue. Pub/Sub keeps one outstanding message per key, and after a nack it redelivers that message and all later ones for the key, which matches the port's "stop processing the group after the first failure" rule without extra code. Order is lost when a message goes to the dead-letter topic, as with SQS FIFO redrive. Publishers must use the regional endpoint for ordered publishes and keep a key in one region; a failed ordered publish pauses that key in the client libraries, and the REST adapter has no such state, so it must fail the whole `send` and let the caller retry the batch in order (documented; to verify behaviour in G8).
- Dead letters: `max_delivery_attempts` 5 to 100, best effort and approximate. Configuration maps from `maxReceiveCount`; values below 5 are a validation error for this queue, and the Lambda-specific floor (`CONSUMER_MAX_MISSING_ATTEMPTS`) must be checked against it in G5 (the claim-missing acknowledgement still needs a few attempts). The service agent needs `roles/pubsub.publisher` on the dead-letter topic and `roles/pubsub.subscriber` on the subscription; the module grants both.
- Size: messages up to 10 MB, so the claim-check keeps real messages around a kilobyte and `maxBytes` is never the limiting factor; the adapter still validates the encoded size (base64 inflates by a third) and rejects, never truncates. The 100-attribute and 1 KiB value limits bound the attributes used (two).
- Ack deadline versus processing time: the push subscription's `ack_deadline_seconds` is the visibility analogue. Core requires visibility to cover six consumer timeouts (`QUEUE_VISIBILITY_FACTOR`). If the maximum push ack deadline is 600 s (to verify; the fetched pages did not state it), consumer `timeoutSec` can be at most 100 s, below Cloud Run's own 60-minute ceiling; the validator needs a platform-provided maximum for the visibility setting rather than the SQS 43,200 s constant. A long archive worker (M4) is the pressure point and must use continuation messages, which the archival design already does.
- Concurrency: no per-subscription concurrency limit exists for push; Pub/Sub's slow-start flow control grows the number of outstanding messages as responses succeed. Concurrency control is Cloud Run `max_instance_count` times `concurrency`; excess requests get 429 and become nacks with backoff. `maxConcurrency` in `QueueTriggerSettings` therefore maps to the Cloud Run service scaling of that function, not to the queue.
- Authentication: the push subscription carries an OIDC token from a dedicated push service account with the bare service URL as audience; Cloud Run verifies it when `run.invoker` is bound (no application-level JWT check in G5; the push handler additionally checks the `subscription` field against the configured set and the body shape). Standalone or non-Cloud-Run hosts that want in-app verification can add a JWKS verifier on WebCrypto later.

### 4.3 Producer

`topics/{topic}:publish` through G0 tokens, batches up to 1,000 messages and 10 MB, partial failure is all or nothing per request (retry the whole request; duplicates are harmless). No client-side batching window; the call returns after the service acknowledges publication.

## 5. Auth, IAM, secrets and networking

### 5.1 Identities

One user-managed service account per physical Cloud Run function (so the per-role grants are separable like AWS roles); a push service account per subscription (or one per stack, invoker only on the consumer services it feeds); a Scheduler service account (invoker only); no default compute service account, no key files in deployed functions (`GOOGLE_APPLICATION_CREDENTIALS` is never set on Cloud Run; the metadata server supplies tokens). Operator commands use application default credentials or a key file, resolved in the CLI only.

### 5.2 Least privilege per requirement row

GCP IAM is bindings (member, role, optional condition) on a resource, not policy documents with actions. The descriptor's capability output therefore becomes a "binding document": a JSON list of `{ role, resource, condition? }` that `cloud-run-app` applies with `google_*_iam_member` for each function account. This reuses the `json-document` output type and the existing grant derivation; only the platform module and the shape pinning (`output-shapes.json`) differ. A reviewed mapping per requirement row:

| Requirement | GCP binding |
|---|---|
| blob `read` / `list` | `roles/storage.objectViewer` on the bucket (get and list); a prefix condition on `resource.name` where uniform bucket-level access allows it |
| blob `write` | custom role with `storage.objects.create` and `storage.objects.delete` (overwrite needs delete) |
| blob `delete` | the same custom role, or `storage.objects.delete` alone |
| store `read` / `write` / `metadata-delete` (Firestore) | custom roles with `datastore.entities.get|list`, `create|update`, `delete` on the project, optionally conditioned on the database resource; AWS-style per-key narrowing (`key-read`, `release-read` via `LeadingKeys`) has no Firestore equivalent, so those capabilities collapse into `read` and the narrowing is lost (documented loss; Firestore security rules do not apply to server credentials) |
| store (Cloud SQL) | `roles/cloudsql.client` and `roles/cloudsql.instanceUser`; SQL privileges decide read, write, delete, as with RDS IAM |
| queue `produce` | `roles/pubsub.publisher` on the physical topic |
| queue `consume` | no binding on the consumer; instead `roles/run.invoker` for the push account on the function's service |
| secret reads | `roles/secretmanager.secretAccessor` on exactly the declared secret |
| KV | Firestore roles as the store, on the KV collection if conditions allow, else the same custom role |

Custom roles are defined at project scope by the `firestore` and `gcs` modules. The exact permission lists are verified by tests that deny everything else in G6 (mutation tests on the binding documents) and by an observed-permission pass in G8.

### 5.3 Where triggers live

Following the AWS design (event source mappings and EventBridge rules live in `lambda-app`), the platform module owns push subscriptions, Scheduler jobs and invoker bindings; the queue module owns topics, dead-letter topics and publisher bindings. This avoids a module cycle (function env needs topic names, subscriptions need function URLs).

### 5.4 Secrets

Secret Manager, delivered as binding kind `secret` whose value is the full secret resource name (version `latest` unless pinned); read at runtime through the GCP `SecretSource` (REST `versions/latest:access`, scrubbed errors) so rotation and lazy reads match the AWS design. Alternative: Cloud Run native secret environment variables (simpler, but the value is fixed at revision start and appears in the service configuration surface). Terraform never sees secret values; the bootstrap secret is created by the bootstrap role (`secretmanager.secrets.create`, `secretmanager.versions.add` scoped by an IAM condition on the secret name), parallel to the Secrets Manager statement in `lambda-app`.

### 5.5 Networking

Ingest and API services are public (invoker `allUsers`, application-level auth, ingest CORS is the app's job because Cloud Run adds none). Consumer, record, cron and bootstrap services require authentication; whether `ingress = internal` is possible for Pub/Sub and Scheduler callers is to verify (do not assume; default `all` with IAM required). Cloud SQL: default unix socket over the built-in proxy with a public-IP instance (no authorized networks), or private IP over Direct VPC egress (or a connector when Cloud NAT is also needed, since the docs report 30 s or more cold start penalties for Direct VPC egress with Cloud NAT) with `egress = private-ranges-only`; Firestore, Pub/Sub, GCS and Secret Manager are public Google APIs (Private Google Access when the egress setting is `all-traffic`). Connection budget: Cloud SQL tier connection limits divided by maximum instances times the pool size (cap with `max_instance_count`).

## 6. Owner decisions still open

Each: options, recommendation, reason. "Before" names the blocked slice.

D1. Cloud Run services versus Cloud Run functions (gen2) (before G5). Options: services deployed from container images; functions (source or ZIP deploy). Recommend services from container images. Reason: functions gen2 are Cloud Run services anyway; images give one pipeline for the standalone image, the DuckDB `archive` role (M4 D6) and every role, with exact Node and extension control; no new packaging beyond a Dockerfile per role.

D2. One service with path routing versus one per role (before G5). Options: per role (the AWS default `split`), all roles in one service, operator-chosen grouping through the existing `roles`/`split` config. Recommend operator-chosen grouping with the AWS-like default (ingest, api, consumer, cron split; record split when grouped mode is on; bootstrap always split). Reason: separate service accounts give least privilege and per-role scaling and timeouts; grouping stays available for small deployments because the handler already routes by path (`/_errtraq/push/*`, `/_errtraq/cron/*`, public paths).

D3. Firestore database mode, edition and location (before G3 infra and G6). Options: native Standard regional (same location as Cloud Run); native multi-region; Enterprise edition. Recommend native Standard, regional, in the stack region, delete protection from the stack `protection` setting. Reason: cheapest and matches COST_ESTIMATE; multi-region costs more with no requirement; Enterprise is a different query model. The location is immutable after creation, so decide before the first apply.

D4. Firestore client: REST over fetch versus the official Node SDK (before G3). Options: hand-written REST client (`documents:commit`, transactions, `runQuery`, structured values); `@google-cloud/firestore` (gRPC, large). Recommend REST over fetch. Reason: keeps the adapter Workers-compatible like `kv-dynamodb`, small cold start, one `gcp-auth` path, and testable with request fixtures; the cost (structured value encoding, transaction retry) is bounded and sits in one module. Reconsider only if a REST limitation blocks (for example `transformResults` for `increment`, to verify first in G3b).

D5. KV backend on GCP (before G3b). Options: Firestore (`kv-firestore`); Memorystore for Redis (new `kv-redis`, VPC egress, from about $35 per month); both, selectable. Recommend Firestore for the first version, with the measured hot-key limit recorded in G8 and Redis as a follow-up if the DSN-key counter or a hot issue window contends. Reason: no VPC dependency, serverless, the failure mode is fail-open (`onKvFailure: "allow"`) rather than data loss; Redis adds a networking prerequisite to every Cloud Run role.

D6. Emulators (before G1 to G3). Candidates: Firestore emulator from the Cloud SDK (`gcloud emulators firestore start`, port 8080); Pub/Sub emulator (`gcloud beta emulators pubsub start`, port 8085, supports push over http, ordering, dead-letter, retry policy); a GCS server: `fake-gcs-server` (Go, docker image, widely used, still receiving releases) versus Google's `storage-testbench` (Python, supports JSON and gRPC with failure injection, "not an officially supported product", limited issue support). Recommend the Cloud SDK emulators for Firestore and Pub/Sub, `fake-gcs-server` for GCS, with a G1 spike confirming `ifGenerationMatch`, resumable upload and list paging, and `storage-testbench` as the fallback or a second opt-in target. Reason: official for the two services where fidelity matters most; fake-gcs-server is the easiest to run under Docker. Known gaps to document: no index tracking, simple locking and up to 30 s lock waits in the Firestore emulator; no IAM and no OIDC verification in the Pub/Sub emulator. The images or local installs must be pinned by the harness (like the winterbaume installer) rather than assumed on the machine.

D7. GCP region (before G6/G7 examples). Options: a Tokyo region, a US region, none (variable only). Recommend `asia-northeast1` as the example default and a required variable otherwise. Reason: matches the AWS verification region and the owner's location; Firestore location and Pub/Sub ordering regional endpoints must agree with Cloud Run.

D8. Real GCP project for verification, and when (before G8). Options: owner supplies a sandbox project now so G1 to G3 can include one real-service spike each; at G8 only; never (emulators only). Recommend a sandbox project available by the time G5 merges, and a short, billing-capped early spike (one Firestore index build, one OIDC push to a hello-world Cloud Run service) during G2. Reason: the two biggest unknowns (index requirements, OIDC push semantics) are exactly what emulators cannot prove, and discovering them at G8 would reopen the adapters. No agent applies Terraform; the operator does.

D9. Cloud SQL connectivity and TLS (before G4). Options: unix socket over the built-in proxy; TCP to private IP with a pinned server CA (per-instance CA mode certificate checked against the `project:instance` name, since the certificate does not match the IP) ; the Node.js connector library. Recommend the unix socket as the default and TCP private IP as the documented alternative, no connector dependency. Reason: the socket needs no TLS code and the proxy encrypts; the TCP path is only for operators who forbid a public IP, and a connector would add a dependency and Admin API quota consumption.

D10. Secret delivery (before G5). Options: runtime read through a `SecretSource`; Cloud Run native secret env vars. Recommend runtime read. Reason: parity with AWS (rotation, scrubbed errors, the bootstrap vault), and the secret never appears in service configuration.

D11. Terraform provider floor (before G6). Options: `~> 7` latest line; `~> 8.0`. Recommend `~> 8.0` after the G6 reading of the 8.0 upgrade guide confirms none of the used resources or fields were removed; otherwise the latest 7.x with a recorded migration item. Reason: 8.0 is GA and new work should not start on a line scheduled for upgrade pressure; never `google-beta`.

D12. Image build and registry (before G5). Options: `errtraq build` emits Dockerfile plus bundle and the operator builds and pushes (docker or Cloud Build) with the digest passed as a Terraform variable; Terraform builds through a Cloud Build trigger; source deploy. Recommend the first, the Artifact Registry repository being operator-owned. Reason: matches the existing content-addressed artifact approach (AWS `artifactBucket`) and keeps image builds out of `terraform apply`.

D13. Record mode default on GCP (before G5). Options: grouped (Pub/Sub ordering on `record`), direct. Recommend grouped by default. Reason: COST_ESTIMATE marks it mandatory for Firestore (hot issue documents), and ordering per issue is available.

D14. Scope of the archive tier on GCP (before any archive work). Options: defer entirely; BigLake REST catalog; self-hosted Lakekeeper. Recommend defer until M4m, then spike BigLake against DuckDB for v3 and deletes. Reason: M4's physical-erase path is itself unproven on AWS.

## 7. Risks and unknowns

1. Firestore per-document write rate has no documented number on the quotas or best-practices pages; the 1 write per second figure is an assumption. Hot issue, DSN-key counter and rate-rejection windows could dominate cost or fail. Mitigated by grouped mode, window-keyed counters, fail-open, and G8 measurement; Redis (D5) is the escape hatch.
2. Index correctness is unprovable offline: the emulator runs any valid query. Mitigated by a declarative `indexes.ts`, an index-coverage test and a real-Firestore check, and a clear error naming the missing index. The `__name__ ASC` tie order with descending sorts needs confirmation on real Firestore.
3. Sequential indexed `receivedAt` on events can cap a collection at about 500 writes per second; per-project subcollections and the expected volume make it a low risk, with a day-bucket fallback.
4. OIDC push is not exercised by the Pub/Sub emulator (not documented); real behaviour (token age up to an hour, audience, `run.invoker`, `ingress = internal`) is verified only at G8; the early spike in D8 reduces it.
5. Push ack deadline maximum, retry policy bounds, and the per-subscription concurrency model were not on the fetched pages (to verify); they decide the consumer timeout ceiling (six times rule).
6. Ordered publishing through REST has no client-library pause-on-failure; the adapter's all-or-nothing batch retry must preserve order, and a failed publish that partially landed could reorder. Needs a G2 fault test and a G8 check.
7. Dead-letter delivery is best effort and approximate, and breaks order; redrive from the DLQ must be an operator procedure like SQS.
8. IAM granularity: Firestore has no key-prefix narrowing, so the `key-read` and `release-read` narrowing available on DynamoDB is lost; the security contract and docs must say so. GCS prefix conditions and Firestore database conditions need confirmation. Custom role permission lists are only provable at G8.
9. Cloud SQL: token lifetime versus pool lifetime, the 100 connections per instance cap, Direct VPC egress cold starts with NAT, TLS name mismatch on the direct private IP path, and the `provisionIamUser` privilege model differ from RDS; the first real run is G8.
10. Workers compatibility: the GCP adapters stay fetch-only, but `blob-gcs` streaming uploads and `gcp-auth` key signing must be proven under the Workers bundle check (G0, G1), and the Cloud SQL adapter is Node only like the RDS one.
11. M4i coupling: G5 edits the files M4i is changing; the audit is deferred and the `QueueTriggerSettings` and requirement-row changes in G5 could conflict with M4i's archive role routing. Start G5 only after merge.
12. Provider churn: google provider 8.0 removed fields; modules must pin and test against one floor. Cloud Run, Pub/Sub and Firestore resource arguments change across provider lines; `terraform validate` in CI is the guard.
13. PII copies for erasure on GCP: Firestore point-in-time recovery and backups, GCS soft delete and object versioning, Pub/Sub retained and dead-letter messages, Cloud Logging. The modules disable what they can and the erasure docs list the rest (the AWS PITR note applies).
14. Cost: the COST_ESTIMATE GCP row assumes issue batching and one request per Pub/Sub message; GCS envelope staging is the largest line, as on AWS. Unchanged by this plan, but G8 must sample it.
15. Emulator drift and test cost: three emulators (Java Firestore, Pub/Sub, a Go or Python GCS server) in the opt-in suite; each pinned and skipped when absent, never in the default path.

## 8. Verification summary per slice

| Slice | Offline (default gate) | Opt-in |
|---|---|---|
| G0 | TokenSource contract, JWT signer vectors | none |
| G1 | request-shape tests, `blobStoreContract` on a fetch fake where the contract allows | GCS emulator contract run |
| G2 | producer and push-decoding tests, `queueContract` additions, hand-written push fixtures | Pub/Sub emulator contract run |
| G3, G3b | key and value encoding, size guard, index coverage, `activeStoreContract` on a recorded fake where feasible | Firestore emulator contract run |
| G4 | pool config, descriptor, stack schema, unchanged postgres suites | existing local Postgres suite |
| G5 | handler, validation, build manifest, infra-gen snapshots | none |
| G6 | `terraform validate`, `terraform test` with mock providers, binding-document mutation tests | none |
| G7 | generation snapshots | `pnpm gcp-emulator` end-to-end |
| G8 | none | real project, operator-run |

## 9. Sources (fetched 2026-11-25)

- Firestore quotas and limits: https://docs.cloud.google.com/firestore/quotas
- Firestore best practices (hotspots, sequential indexed fields): https://docs.cloud.google.com/firestore/native/docs/best-practices
- Firestore TTL policies: https://docs.cloud.google.com/firestore/native/docs/ttl
- Firestore emulator: https://docs.cloud.google.com/firestore/native/docs/emulator
- Pub/Sub push subscriptions: https://docs.cloud.google.com/pubsub/docs/push
- Pub/Sub push authentication: https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
- Pub/Sub ordering: https://docs.cloud.google.com/pubsub/docs/ordering
- Pub/Sub dead-letter topics: https://docs.cloud.google.com/pubsub/docs/handling-failures
- Pub/Sub quotas: https://docs.cloud.google.com/pubsub/quotas
- Pub/Sub emulator: https://docs.cloud.google.com/pubsub/docs/emulator
- Cloud Run quotas and limits: https://docs.cloud.google.com/run/quotas
- Cloud Run service identity and metadata tokens: https://docs.cloud.google.com/run/docs/securing/service-identity
- Cloud Run Direct VPC egress: https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc
- Cloud Run to Cloud SQL (PostgreSQL): https://docs.cloud.google.com/sql/docs/postgres/connect-run
- Cloud SQL IAM database authentication: https://docs.cloud.google.com/sql/docs/postgres/iam-logins
- Cloud Scheduler HTTP target authentication: https://docs.cloud.google.com/scheduler/docs/http-target-auth
- GCS uploads (JSON API): https://docs.cloud.google.com/storage/docs/json_api/v1/how-tos/upload
- GCS request preconditions: https://docs.cloud.google.com/storage/docs/request-preconditions
- GCS signed URLs: https://docs.cloud.google.com/storage/docs/access-control/signed-urls
- GCS emulators: https://github.com/googleapis/storage-testbench and the `fsouza/fake-gcs-server` project (search results only, maintenance status to confirm in the G1 spike)
- BigLake metastore Iceberg REST catalog: https://cloud.google.com/bigquery/docs/blms-rest-catalog and DuckDB Iceberg REST catalogs: https://duckdb.org/docs/current/core_extensions/iceberg/catalogs
- Terraform provider for Google Cloud 8.0: https://hashicorp.com/blog/terraform-provider-for-google-cloud-80-now-generally-available
