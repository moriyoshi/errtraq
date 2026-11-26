# GCP emulator gaps

What `pnpm test:gcp-emulated` (and the per-service `test:*-emulated` scripts) cannot check, so that a green run is not
read as more than it is. G8 (real project, operator-run) is where each item below gets verified. Sources: the G1 to G4
harness findings in JOURNAL.md and the G7 end-to-end run.

## The suite in one paragraph

`scripts/gcp-emulated/run.mjs` starts the pinned Cloud SDK Firestore and Pub/Sub emulators and `fake-gcs-server` in
containers named `errtraq-g7-*` on free loopback ports, sets `FIRESTORE_EMULATOR_HOST`, `PUBSUB_EMULATOR_HOST` and
`STORAGE_EMULATOR_HOST`, runs the four adapter contract suites, then runs the Cloud Run handler built from
`scripts/gcp-emulated/stack.ts` as a process: real `@sentry/node` sends errors to its ingest, the Pub/Sub emulator pushes
the queued events to `/_errtraq/push/shared`, and the API must show grouped, counted issues. It skips (exit 0, with a
message) when Docker or an image is unavailable. The Cloud SQL path stays in `pnpm test:cloudsql-emulated` (a local
PostgreSQL over a unix socket).

## Test-only substitutions in the end to end

| Real deployment | In the emulated run | Consequence |
| --- | --- | --- |
| Metadata server issues OAuth tokens and the service account email | a fake metadata server (`GCE_METADATA_HOST`) issues the token `owner` | the Firestore emulator treats any other bearer token as a real credential and answers `INVALID_ARGUMENT`; `owner` is its documented bypass. Token handling beyond "a token is attached" is untested |
| Pub/Sub attaches an OIDC token, the handler verifies it (`verifyGoogleIdToken`) | `pushAuth: "none"` in the test stack | OIDC verification (signature, issuer, audience, expiry, invoker email) is not exercised end to end; unit tests cover the verifier with fixtures |
| Cloud Run `run.invoker`, ingress and `custom_audiences` in front of the handler | the process listens on a loopback port | none of the invoker or ingress rules is exercised |
| Secret Manager bootstrap vault | an in-memory vault in the harness | the version-1 convergence under concurrent bootstraps is untested |
| Terraform-created topics, subscriptions, bucket | created by the harness through the emulators' REST APIs | the modules are validated by `pnpm infra:validate` (mock providers) only; nothing is ever applied |
| Record mode `grouped` (the GCP default) | `recordMode: "direct"` | the emulator's push body has no `orderingKey` (below), so the record queue cannot be driven |

### The push switch cannot be enabled in a deployment

`pushAuth: "none"` of `queue-pubsub` skips push verification, including a verifier the host injects. It is refused
unless the adapter talks to a loopback Pub/Sub emulator (`endpoint` or `PUBSUB_EMULATOR_HOST` on `127.0.0.1`,
`localhost` or `[::1]`; a deployed function cannot publish to one) and is refused outright when `K_SERVICE` or
`K_REVISION` is set (Cloud Run always sets them; both are reserved bindings). A non-loopback `endpoint` together with
`none` fails config validation. `platform` (authentication by Cloud Run `run.invoker`) is a separate, intended mode.

## Firestore emulator

- Composite and single-field indexes are not enforced. Every query that real Firestore would reject with
  `FAILED_PRECONDITION` because an index is missing succeeds here, so the generated index list (`indexes.ts`, the
  `google_firestore_index` resources) is verified only by comparison with the queries in code, never against the service.
- No TTL deletion (the `kv.expireAt` policy and the event TTL); reads check expiry, deletion lag is unobserved.
- No IAM: custom roles, the `resource.name` conditions on `datastore.*` permissions and the least-privilege permission
  sets are untestable. Any request is allowed.
- No quotas or limits behaviour: write rate ramp-up (500/s), one sustained write per second per document, the 1 MiB
  document and 10 MiB commit limits, contention retry rates. Locking is pessimistic like production but timing and abort
  rates differ; the transactional single read uses `documents:batchGet` because the emulator cannot map the base64
  `transaction` query parameter of a GET.
- Multi-region and location semantics: the emulator ignores the database location.

## Pub/Sub emulator

- Push bodies carry no `deliveryAttempt` and no `orderingKey` (observed at G2). Attempt-based logic (the dead-letter
  arithmetic, `minQueueDlqAttempts`) and the per-key ordering of the `record` queue cannot be verified; the contract
  suite counts deliveries in the receiver instead.
- No OIDC token on push, no service agent, no IAM (`pubsub.publisher`, the dead-letter grants).
- Retry policy backoff, ack deadline expiry and dead-letter forwarding are accepted but not timed like production.
- No regional endpoints (ordered publishes use the one emulator origin), no message retention or storage policy
  (`allowed_persistence_regions`).
- Push endpoints must be reachable from inside the container (`host.docker.internal`; override with
  `ERRTRAQ_PUBSUB_PUSH_HOST`).

## fake-gcs-server

- No IAM or signed URL verification: V4 signed URLs are produced but never accepted or rejected.
- A missing bucket and a missing object both answer a bare `Not Found`, so the 404 body wording `blob-gcs` uses to tell
  them apart is unverified.
- Resumable-upload status queries (`bytes */*`) finalize the upload instead of reporting progress, so chunk recovery is
  covered by a fetch fake only.
- Lifecycle rules, soft delete, bucket location immutability and uniform bucket-level access are not enforced.

## Not covered at all by the emulated suite

- Cloud Scheduler (the cron route is only checked to reject an unauthenticated call), Secret Manager, Artifact Registry.
- Cloud Run behaviour: concurrency and instance caps, cold start, container image, VPC egress, the Cloud SQL socket mount.
- Cloud SQL IAM login: the `opt-in` socket script uses password authentication as a stand-in, so the `sqlservice.login`
  scope, token expiry against pooled connections and the `cloudsqlsuperuser` grants on a schema owned by another user are
  G8 items. The SQL grant model (the migrating user owns the tables, the other function users get data access through
  the owner's grants and default privileges) is exercised against PostgreSQL only.
- Quotas, billing, regional availability, organization policies (for example domain-restricted `allUsers` invokers).
