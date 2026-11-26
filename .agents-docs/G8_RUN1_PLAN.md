# G8 run 1: first real GCP verification plan

Status: pre-run build done (G8a, 2026-11-26), run pending. Written without any cloud access: the probes
and helpers below are unit tested offline against mocked `fetch`, and nothing in this plan has been
executed against a real project. The operator (Claude Opus with the owner) runs it.

Scope of run 1 (owner decision): Firestore, Pub/Sub, GCS, Cloud Run, Cloud Scheduler and Secret Manager.
No Cloud SQL (run 2). The bootstrap variant is used: the operator invokes the bootstrap service with an
ID token. Push authentication is `pushAuth: "verifier"` (the default; real OIDC push).

Nothing environment specific lives in the repository. The project comes from the operator's gcloud
configuration and is exported as an environment variable; the region is passed explicitly (GCP_PLAN D7);
every artifact of the run goes to the git-ignored `.agents-workspace/tmp/g8/`. Probe output is scrubbed
(project, region, e-mail addresses, URLs and tokens become placeholders) and is safe to paste into a
journal entry.

## 1. Prerequisites

### 1.1 Tools on the operator machine

Node and pnpm as in the repository, Terraform 1.9 or newer, the gcloud CLI, and for the Docker builder a
Docker daemon. The daemon is shared with other projects (Colima): only `errtraq-*` image names are built,
nothing is pruned, the daemon is never restarted. `pnpm install --frozen-lockfile && pnpm build` first
(the probes import the built adapters, and the CLI runs from `packages/cli/dist`).

### 1.2 APIs to enable (exactly these)

| API | Why |
| --- | --- |
| `run.googleapis.com` | Cloud Run services (and the probes' service reads) |
| `pubsub.googleapis.com` | topics, push subscriptions, dead-letter topics; creates the Pub/Sub service agent |
| `cloudscheduler.googleapis.com` | the two cron jobs |
| `firestore.googleapis.com` | the store and KV databases |
| `secretmanager.googleapis.com` | the bootstrap secret |
| `storage.googleapis.com` | the blob bucket |
| `iam.googleapis.com` | service accounts, custom roles |
| `iamcredentials.googleapis.com` | the operator's ID token (impersonation), `signBlob`, per-account probes |
| `cloudresourcemanager.googleapis.com` | project IAM bindings (Terraform) and the policy reads of the iam probe |
| `artifactregistry.googleapis.com` | the image repository |
| `serviceusage.googleapis.com` | the provider and the inventory probe list and use services |
| `cloudbuild.googleapis.com` | only when the image is built with `--builder cloud-build` |

Not enabled: `sqladmin.googleapis.com`, `compute.googleapis.com`, Cloud Logging and Monitoring need nothing
beyond their defaults. Enabled APIs stay on after the destroy (section 9).

### 1.3 Operator setup (outside Terraform, each item is a leftover to remove in section 9)

1. Environment (values from `gcloud config`, never typed into a file):
   `ERRTRAQ_GCP_PROJECT` (the active project), `ERRTRAQ_GCP_REGION` (chosen explicitly now), and
   `ERRTRAQ_GCP_AR_REPO` (the Artifact Registry repository name, for example `errtraq`).
2. The Artifact Registry Docker repository in that region (`gcloud artifacts repositories create`).
3. An operator service account, because a user account cannot mint an ID token for a custom audience
   (`gcloud auth print-identity-token --audiences` needs a service account). Create `errtraq-g8-operator`,
   give your own user `roles/iam.serviceAccountTokenCreator` on it, and export
   `ERRTRAQ_GCP_OPERATOR_MEMBER=serviceAccount:<its email>` (the stack grants it `run.invoker` on the
   bootstrap service) and `ERRTRAQ_GCP_IMPERSONATE_SA=<its email>` (the probes and the bootstrap helper
   mint ID tokens through it). The CLI accepts the resulting token alone (`ERRTRAQ_GCP_ID_TOKEN`, fixed in
   G8a: it used to demand application default credentials as well).
4. For the iam probe and `--as-push-sa`: your user needs `roles/iam.serviceAccountTokenCreator` on the
   function accounts and on the push account. The simplest is a project-level grant to yourself for the
   duration of the run (remove it in section 9). Without it those checks report SKIP.
5. A billing budget alert on the project (console), as the cost guard of section 8.
6. Access token for the probes: `export ERRTRAQ_GCP_ACCESS_TOKEN=$(gcloud auth print-access-token)`;
   it expires after an hour, re-export when probes report 401. It lives in the environment only.
   Docker login for the push: `gcloud auth print-access-token | docker login -u oauth2accesstoken
   --password-stdin <region>-docker.pkg.dev` (undo with `docker logout`).

## 2. The run stack

`node scripts/gcp-verify/stack.mjs` writes `.agents-workspace/tmp/g8/stack.ts` plus copies of the two example
stacks it builds on (`gcp-env.ts`, `gcp-firestore.ts`). The example stacks use `.ts` import specifiers, so the
CLI also loads them directly.

It derives from `stacks/gcp-firestore-bootstrap.ts` with three changes: the `record` role and grouped
recording (so the ordered `record` queue, `orderingKey` and `deliveryAttempt` are exercised; the example
uses direct recording), `protection: "disposable"` (the example's production protection would keep the
Firestore databases and block the destroy), and the stack name `gcp-g8` with the bootstrap secret
`errtraq-bootstrap-gcp-g8`. Options: `--ingress-internal` (variant B, section 6.3), `--rate-limit <n|disabled>`.

```
node scripts/gcp-verify/stack.mjs
node packages/cli/dist/bin.js validate --stack .agents-workspace/tmp/g8/stack.ts
node packages/cli/dist/bin.js build --stack .agents-workspace/tmp/g8/stack.ts --out .agents-workspace/tmp/g8/build
```

## 3. Image

Cloud Run needs linux/amd64. The Dockerfile only copies the bundles onto `node:26.13.1-bookworm-slim`
(the tag exists on the registry, checked 2026-11-26), so no emulated step runs on an arm64 host.

```
node scripts/gcp-verify/image.mjs --build-dir .agents-workspace/tmp/g8/build            # dry run: prints the commands
node scripts/gcp-verify/image.mjs --build-dir .agents-workspace/tmp/g8/build --execute  # docker build and push
node scripts/gcp-verify/image.mjs --build-dir .agents-workspace/tmp/g8/build --builder cloud-build --execute
```

Project, region and repository come from the environment (or `--project`, `--region`, `--repo`). The image is
named `<region>-docker.pkg.dev/<project>/<repo>/errtraq-app:g8-<hash of the build manifest>`; the command
prints `export TF_VAR_CLOUD_RUN_IMAGE=<reference>@sha256:...`, which is what Terraform gets. Prefer Docker.
Cloud Build uploads the build directory to a staging bucket in the project and, on projects created after
2024, builds as the Compute default service account, which then needs Artifact Registry write access (pass
`--cloud-build-service-account` for another one). The staging bucket is a leftover.

## 4. Plan and review (before every apply)

```
node packages/cli/dist/bin.js infra generate --stack .agents-workspace/tmp/g8/stack.ts \
  --build-dir .agents-workspace/tmp/g8/build --out .agents-workspace/tmp/g8/root
cd .agents-workspace/tmp/g8/root && terraform init && terraform plan -out=tfplan
terraform show -json tfplan > ../plan.json
```

Show the plan to the owner and check each of these (the commands read `plan.json` with `jq`):

1. Public exposure: `invoker_iam_disabled = true` on exactly two services, `gcp-g8-ingest` and `gcp-g8-api`,
   and no `allUsers` member anywhere (run 1 found the organization's domain restriction rejects it). Every other invoker is the push account (consumer, record),
   the scheduler account (cron) or the operator member (bootstrap). No `allAuthenticatedUsers` anywhere.
   `.resource_changes[] | select(.type|test("iam_member")) | {address, member: .change.after.member}`.
2. No primitive roles: no `roles/owner`, `roles/editor`, `roles/viewer` in any binding. Project-level bindings
   of function accounts name only the stack's custom roles (`gcp_g8_blob_*`, `gcp_g8_fs_store_*`,
   `gcp_g8_fs_kv_*`, `gcp_g8_bootstrap_secret`).
3. Conditions as designed: the Firestore roles carry `resource.name == "projects/<p>/databases/gcp-g8-store"`
   (or `-kv`); the bootstrap secret role carries the name condition with the project number; the push
   account is not bound to any role besides `run.invoker` on the consumer and record services; the Pub/Sub
   service agent holds `serviceAccountTokenCreator` on the push account and publisher and subscriber on the
   dead-letter resources only.
4. Custom role permission lists: blob `get`, `list`, `create` plus `delete`, `delete`; Firestore
   `datastore.databases.get` with `entities.get|list`, `create|update`, `delete`; secret `create`, `get`,
   `versions.add`, `versions.access`. Nothing wider.
5. Resource set: 6 Cloud Run services, 2 Scheduler jobs, 2 Firestore databases with their indexes,
   field configurations and TTL, 2 topics plus 2 dead-letter topics and subscriptions, 1 bucket, service
   accounts (6 functions, push, scheduler). The bucket has no soft delete and public access prevention.
   No Cloud SQL, no VPC, no key resources, no `google_project_service`.
6. Values: concurrency 80 (ingest, api), 8 (consumer, record), 1 (cron, bootstrap); max instances 20;
   `cpu` rendered as `1000m`; ack deadline 180 s; `max_delivery_attempts` 5; `custom_audiences`
   `errtraq-push`; the image variable is the digest-pinned reference from section 3.

Anything unexpected stops the run; fix and plan again.

## 5. Apply

`terraform apply tfplan`, timed (record the wall clock and which resource took longest: the Firestore index
build time is a G8 item). If it fails on the concurrent index limit, rerun `terraform apply -parallelism=1`
after a new plan. Then:

```
terraform output -json > ../outputs.json
terraform show -json > ../state.json
terraform plan -detailed-exitcode        # exit 0: no drift, the repeat-plan check of the AWS run
```

Note anything the provider rewrites on the second plan (the AWS run found lowercase header drift this way).

## 6. Run

All probes read `--outputs .agents-workspace/tmp/g8/outputs.json` (or `ERRTRAQ_GCP_OUTPUTS`) and print
PASS, FAIL, SKIP or INFO lines; the exit code is non-zero on any FAIL. A common prefix:
`P="node scripts/gcp-verify"`, `C="--outputs .agents-workspace/tmp/g8/outputs.json"`.

### 6.1 Order

| Step | Command | What it checks |
| --- | --- | --- |
| 1 | `$P/deploy.mjs $C --only cold` | cold start: first request latency of ingest, api and bootstrap after the services idled (run before anything else warms them) |
| 2 | `node scripts/gcp-verify/bootstrap.mjs $C --stack-file .agents-workspace/tmp/g8/stack.ts` | the operator ID token call to the private bootstrap service; creates the org, project, key, API token and the secret |
| 3 | repeat step 2 | idempotent: "already existed" for everything |
| 4 | three copies of step 2 started together, then `$P/deploy.mjs $C --only secret` | concurrent bootstraps converge on one secret version |
| 5 | `$P/run.mjs $C --probes deploy,sdk,push,firestore,gcs,cron,iam --state .agents-workspace/tmp/g8/state.json --as-push-sa --operator $ERRTRAQ_GCP_OPERATOR_MEMBER` | everything below (or each probe on its own: `$P/push.mjs ...`) |
| 6 | `$P/firestore.mjs $C --only ttl-check` | TTL deletion lag, hours after step 5 planted the document |
| 7 | variant B and the optional experiments (6.3, 6.4) | |
| 8 | `$P/run.mjs --probes inventory --expect present` | what exists before the destroy |

Useful flags: `--only <steps>` on `push`, `firestore`, `gcs`, `deploy`; `--dlq-timeout <s>` (default 900) and
`--dlq-grace <s>` (60) for the dead-letter wait; `--events`, `--background`, `--concurrency`, `--increments`
for load (defaults 200, 20, 32, 200); `--objects` (1205); `--signer-sa <function account email>` for the signed
URL (needs token creator on it and read access of that account to the bucket); `--natural` on `cron` to wait
for the schedule instead of forcing a run; `--run-id` to reuse an id.

### 6.2 Checks and pass criteria

| Probe and check | Pass criterion |
| --- | --- |
| deploy: service settings | concurrency, max instances 20, `1000m` CPU, 512Mi, the function's own service account, no `GOOGLE_APPLICATION_CREDENTIALS` |
| deploy: cold start | status 200; first and second request latencies recorded (INFO) |
| deploy: bootstrap secret | exactly one version |
| deploy: service agent | the Pub/Sub agent holds `serviceAccountTokenCreator` on the push account (exists as designed; whether it is still needed is experiment 6.4a) |
| sdk: auth | ingest answers 401 or 403 for a missing and a wrong key; the API answers 401 for a missing and a wrong token |
| sdk: grouping | real `@sentry/node`: 3 events of one error become one issue with count 3, plus 1 and 1; latest event readable |
| sdk: resolve and regress | resolve through the API, a new event reopens it, count 4 |
| sdk: duplicate envelope | the same envelope posted twice counts once (waits 10 s after the first sighting) |
| push: subscription | endpoint is the consumer URL plus `/_errtraq/push/shared`; OIDC audience `errtraq-push`; the push account; dead-letter policy with 5 attempts; the `record` subscription is ordered |
| push: direct calls | to the consumer URL: no token, a wrong-audience token and the operator's token are each rejected with 401, 403 or 404 (Cloud Run IAM rejects before the handler). With `--as-push-sa`: the push account's token reaches the handler (400 for an empty body), its wrong-audience token and the scheduler account's token are rejected |
| push: delivery | an event sent through ingest is recorded through the real OIDC push (time to record is INFO) |
| push: semantics | ack deadline 600 s accepted, 601 s rejected (the `maxVisibilityTimeoutSec` capability); on a throwaway ordered topic (deleted afterwards) the regional ordered publish works, a nack redelivers the same message before later ones of its key; the global-endpoint ordered publish status is recorded (INFO, the regional-endpoint requirement) |
| push: dead letters | a poison message (undecodable data) reaches `gcp-g8-shared-dlq` with delivery count at least 5; a message with a valid claim and a missing blob is not dead-lettered, because the consumer acknowledges it on attempt 5, which only happens if `deliveryAttempt` arrives in the push body; the record dead-letter subscription is empty |
| firestore: indexes | store and KV composite indexes READY; the `kv.expireAt` field has an ACTIVE TTL policy and no index (the exemption and TTL merge) |
| firestore: list queries | every status filter and sort the API offers, with paging, answers 200 (a missing index would be a 5xx), and the events list |
| firestore: hot issue | 200 events of one error plus 20 of another, staged straight to GCS and the queue (bypassing the ingest rate limit), end as exactly 200 and 20, no dead letters; drain time recorded |
| firestore: hot counter | 200 concurrent `increment` calls on one key (the DSN-key limiter shape) give exactly 200 and unique return values; failures after adapter retries and p50, p95 and max latency recorded |
| firestore: payload boundary | 150 kB (inline), 600 kB (overflow to GCS) and an envelope 4 KiB under 1 MiB are accepted and read back intact through the API; an envelope over 1 MiB is refused with 413 |
| firestore: TTL | a document planted already expired; `ttl-check` later: deleted (lag recorded), or SKIP while it still exists |
| gcs: bucket | uniform access, public access prevention enforced, no versioning, soft delete 0 s, the lifecycle rules, the configured region |
| gcs: conditional write | `ifGenerationMatch=0` succeeds once and then answers 412; an unconditional write overwrites; a stale generation answers 412 |
| gcs: 404 wording | a missing object is a 404 that the adapter does not classify as a missing bucket; a missing bucket is classified as one (the bodies are printed as INFO) |
| gcs: resumable upload | 9 MiB through the stream path stores every byte and reads back identical (the adapter verifies CRC-32C) |
| gcs: paging | 1205 objects under `g8-probe/<run>/list/`: listed once each, in order, over two pages; the raw first page is capped at 1000; all deleted afterwards |
| gcs: signed URL | with `--signer-sa`: the V4 URL is accepted, a tampered signature is rejected; otherwise SKIP (no deployed role presigns today) |
| cron: jobs | both jobs ENABLED with the designed schedule, the scheduler account, audience and URL; the cron route rejects an unauthenticated call |
| cron: recovery | an envelope planted 15 minutes old with no queue message is recorded exactly once after a cron run (forced with `:run`; `--natural` waits for the 5 minute schedule); the job's last attempt succeeded |
| iam: policies | no primitive role on any errtraq account; project-level bindings only the stack's custom roles with the designed conditions; invokers exactly as designed (`allUsers` only on ingest and api); nothing public on the bucket or topics |
| iam: effective permissions | for each function account, impersonated: `testIamPermissions` on the bucket, topics, bootstrap secret and the project, and real reads and writes on each Firestore database, equal what the roles in the state grant (none missing, none extra); probe documents are removed |

Record for the journal: every number marked INFO or "recorded", the apply and index build times, the
second-plan result, and anything surprising in a FAIL.

### 6.3 Variant B: `ingress = internal` for push and Scheduler callees

Regenerate with `node scripts/gcp-verify/stack.mjs --ingress-internal`, rebuild nothing (the image is the
same), plan, review (only the three `ingress` values change), apply, then rerun `push` (delivery,
dead letters) and `cron` (forced run and recovery). Pass: Pub/Sub push and Scheduler still reach the
services (GCP_PLAN 5.5 "to verify"); direct calls from the operator machine are rejected (the accepted
statuses include 404). Fail: events no longer arrive, which settles the question the other way: keep
`ingress = all` with IAM required and record it. Switch back or destroy.

### 6.4 Optional experiments

a. Is the `serviceAccountTokenCreator` grant of the Pub/Sub agent on the push account needed? Remove that one
   binding in the console, rerun `push --only delivers`; if events still arrive, record that and tighten the
   module; restore it with `terraform apply` (the plan shows it re-added).
b. Domain restriction: run 1's project sits in an organization that restricts IAM members, and the first
   apply failed on the `allUsers` invoker. The module now uses `invoker_iam_disabled` instead; the public
   checks of the sdk-e2e probe show it works under that policy.
c. Observed-permission tightening of the custom roles needs Data Access audit logs, which are off by default;
   not part of run 1. The iam probe shows that the granted sets are neither missing nor wider than designed.

## 7. Failure handling

A FAIL does not stop the other probes. Fix forward only for product bugs that block the rest of the run
(with a regression test, committed on the run branch); everything else goes into the journal. If bootstrap
answers 403 while creating the secret, the Secret Manager name condition on `secrets.create` is not honoured
for creation: record it, and proceed by granting the bootstrap account the unconditioned role for the run
(a finding for the module, not a fix to hide).

## 8. Cost guard

Everything scales to zero (min instances 0, max 20 per service); Firestore, Pub/Sub, GCS, Scheduler (2 of 3
free jobs) and Secret Manager bill by use. The heaviest steps are the 1205 GCS objects, the 220 staged events
and the 200 counter increments, a few thousand operations in total, and the image (tens of MB in Artifact
Registry). Expected total well under a few dollars; the budget alert is the backstop, and the run is destroyed
the same day it is applied. Sample the actual bill (billing console, by service) against COST_ESTIMATE after
the run; no script reads billing.

## 9. Destroy and leftover inventory

```
cd .agents-workspace/tmp/g8/root && terraform destroy
node scripts/gcp-verify/inventory.mjs --expect empty          # Terraform-owned resources must be gone
```

Terraform owns: Cloud Run services, Pub/Sub topics and subscriptions, the bucket (disposable protection
empties it), the Firestore databases, Scheduler jobs, service accounts, custom roles and project IAM bindings.
The inventory fails on any of them left. Outside Terraform state, remove or accept each:

| Leftover | Notes |
| --- | --- |
| Bootstrap secret `errtraq-bootstrap-gcp-g8` | created by the bootstrap service, never in state; `gcloud secrets delete`. It holds the DSN and API token. |
| Firestore database ids `gcp-g8-store` and `gcp-g8-kv` | deletion is delayed on the service side and the ids cannot be reused right away; a re-run needs another stack name (`--stack-name`, at most 20 characters). |
| Soft-deleted custom roles | kept for a while, ids blocked; the provider undeletes them on a re-apply with the same ids. |
| Artifact Registry images and the repository | operator-owned; delete the images and, if created for the run, the repository. Local images: `docker rmi <tag>` (exact name, never prune), `docker logout`. |
| Cloud Build staging bucket and build records | only with the Cloud Build builder. |
| Operator service account, token creator grants, the budget alert | section 1.3; remove the project-level `serviceAccountTokenCreator` grant first. |
| Enabled APIs | stay on; disable those the project did not have before if it is shared. |
| Pub/Sub service agent | created by enabling the API; harmless, not removable. |
| Probe leftovers | `g8probe`-named Firestore documents and `g8-probe/` objects are removed by the probes; the inventory prints nothing for them because the databases and the bucket are gone. |
| The unacknowledged messages of the dead-letter peek | die with the topics. |

Finish with `inventory.mjs --expect empty` clean for the Terraform-owned categories, and the table above checked off.

## 10. Mapping of the G8 items

"Run 1" means a check above; "run 2" means the Cloud SQL run; "not checkable" says why.

### GCP_PLAN G8 checklist

| Item | Disposition |
| --- | --- |
| Firestore index creation time | run 1: apply timing (5) and the indexes check |
| `FAILED_PRECONDITION` for a missing index, generated list complete | run 1: firestore list queries (the API's queries only; an index the code would need for a query the API never issues is not seen) |
| Hot issue and hot DSN key contention | run 1: firestore hot issue and hot counter |
| Transaction abort and retry rates | not checkable by a script: the counts live in Firestore metrics with minutes of delay; the operator may read them in the console after the load step and note them |
| Payload at the 1 MiB boundary | run 1: payload boundary |
| TTL deletion lag | run 1: ttl-plant and ttl-check |
| OIDC push end to end (Cloud Run verification, audience, token age) | run 1: push subscription, direct calls, delivery. Token age (up to an hour) is not checkable: it needs a push after a quiet hour; the handler verifier accepts it by design and expiry is covered by unit tests |
| Per-key ordering, redelivery order after a nack | run 1: push semantics (throwaway ordered topic) and grouped record flow through the real `record` queue |
| Dead-letter delivery and `deliveryAttempt` | run 1: push dead letters (`deliveryAttempt` observed through the missing-claim rule) |
| Ack deadline behaviour, six-times rule | run 1: the 600 s maximum; the six-times rule is configuration validation, covered offline |
| Regional endpoint requirement | run 1: push semantics, recorded as INFO |
| Scrubbed real push captures replacing fixtures | not checkable from outside: a push body is only visible to the receiver. Follow-up in TODO: a debug-level log of the push envelope's field names, or a capture service, in run 2 |
| GCS conditional writes, resumable upload, list paging above 1000, signed URLs | run 1: the four gcs checks (signed URL needs `--signer-sa`) |
| Cloud SQL IAM login, unix socket and private IP, token expiry | run 2 (Cloud SQL) |
| Cloud Scheduler to cron | run 1: cron |
| Cold start of each role | run 1 for ingest, api and bootstrap (deploy cold). Consumer, record and cron are private to their callers; their first-request latency shows only indirectly as the push delivery time, recorded as INFO |
| Least-privilege IAM, tighten the custom roles | run 1: iam policies and effective permissions (granted equals designed). The list of permissions actually used needs Data Access audit logs: not in run 1 |
| Cost sample against COST_ESTIMATE | run 1: manual, section 8 |
| Done: journal with measurements, TODO updates, destroy inventory clean | section 9 |

### TODO items tagged G8

| Item (source) | Disposition |
| --- | --- |
| G1: 404 body wording, bucket versus object | run 1: gcs 404 wording |
| G1: V4 signed URL acceptance | run 1: gcs signed URL (`--signer-sa`) |
| G1: `signBlob` self-signing permission | run 1 partly: the iam probe lists what each function account holds; no function account is granted token creator on itself and no deployed role presigns, so a deployed self-sign is expected to fail. Whether to grant it is a product decision when a role needs presigned URLs |
| G1: `devstorage.read_write` scope honoured by the metadata server | run 1, indirectly: every GCS call of the deployed roles requests it, so the sdk and push checks passing shows the token works |
| G4/G8 and G4 items: Cloud SQL login scope, grants, certificates, token expiry | run 2 |
| G2/G5: 600 s ack deadline maximum | run 1: push semantics |
| G2/G5: OIDC push, `deliveryAttempt`, `orderingKey` presence, ordered-publish failure | OIDC push and `deliveryAttempt`: run 1. `orderingKey` presence: only indirectly (the grouped record flow works, and the decoder rejects a present key that disagrees with the group key); direct observation needs a push capture (not checkable, see above). Ordered-publish failure behaviour: not checkable cheaply, a failure cannot be induced on demand |
| G3: index model matches; `exists: true` increments under contention | run 1: list queries and hot counter |
| G5: `sqlservice.login` scope | run 2 |
| G5: `custom_audiences` plus OIDC push and Scheduler end to end | run 1: push, cron |
| G5: `ingress = internal` for push and Scheduler | run 1: variant B |
| G5: bootstrap call with an operator ID token | run 1: bootstrap step (impersonated operator account) |
| G5: Secret Manager vault convergence on version 1 under concurrent bootstraps | run 1: step 4 and deploy secret |
| G5: default concurrency and instance caps | run 1: deploy settings |
| G5: container cold start of the single image | run 1: deploy cold |
| G6: IAM conditions on custom `datastore.*` roles | run 1: iam policies and Firestore reads and writes per account |
| G6: Cloud SQL instance condition | run 2 |
| G6: Secret Manager name condition on create | run 1: bootstrap step (a 403 on create answers it) and iam |
| G6: custom role permission sets complete and not wider | run 1: iam effective permissions |
| G6: Pub/Sub service agent exists, token creator still needed | run 1: deploy service agent and experiment 6.4a |
| G6: concurrent index creation, TTL plus exemption merge | run 1: apply (5) and firestore indexes |
| G6: disabled GCS soft delete | run 1: gcs bucket |
| G6: `allUsers` invoker under domain restriction | run 1 as far as the project's organization allows (6.4b) |
| G6: accepted Cloud Run limit formats | run 1: apply and deploy settings |
| G7: OIDC push with `pushAuth: verifier` | run 1: push |
| G7: grouped record mode with real `orderingKey` and `deliveryAttempt` | run 1: grouped stack, record queue flow, dead letters |
| G7: SQL grant model on Cloud SQL | run 2 |
| G7: operator ID token call as an `operatorMembers` principal | run 1: bootstrap step |
| G-archive items | out of scope (no archive on GCP) |

## 11. What G8a found while building this (product notes)

- The example stacks could not be loaded by the CLI (`./gcp-env.js` has no `.js` file). Fixed in the G8a
  review: the stacks use `.ts` specifiers (`allowImportingTsExtensions` in `tsconfig.node-tests.json`).
- A user account cannot mint an ID token with a custom audience, and the handler's operator verifier checks
  the audience (`errtraq-push`), so the bootstrap call needs a service account's token. An operator
  service account with impersonation is the documented route; accepting the Cloud Run service URL as a
  second audience would also admit gcloud's default user token and is a product decision left open.
- `errtraq bootstrap --remote` demanded application default credentials even when `ERRTRAQ_GCP_ID_TOKEN` was
  set; fixed with a regression test.
