# Google module contracts

These modules are declarative infrastructure for the `google` provider family (`hashicorp/google`,
never `google-beta`). The provider floor is 8.0.0 (`>= 8.0.0, < 9.0`): the 8.0 upgrade guide removes
or changes none of the resources used here. `pnpm infra:validate` validates and tests every module and
both example roots at 8.0.0 and at a recent 8.x release. Project and region are always explicit inputs;
no module defaults either (GCP_PLAN D7, D8). The required APIs (Cloud Run, Pub/Sub, Cloud Scheduler,
Firestore, Secret Manager, Cloud SQL Admin, IAM) are enabled by the operator.

## Binding documents

GCP IAM binds a member to a role on a resource, so the `policies` outputs are JSON lists of
`{ role, resource, condition?, iam_database_user? }` instead of policy documents. `cloud-run-app` binds
each entry to the service account of the function that holds the grant. The `resource` form selects the
Terraform resource, and an unknown form fails the plan:

| `resource` | Applied with |
|---|---|
| `projects/<project>` | `google_project_iam_member` (conditions allowed) |
| `projects/_/buckets/<bucket>` | `google_storage_bucket_iam_member` |
| `projects/<project>/topics/<topic>` | `google_pubsub_topic_iam_member` |

Documents are built only from configured attributes (names and ids), so they are known at plan time:
`cloud-run-app` derives `for_each` keys from them, and the generated-root test plans with every
resource still computed. Custom roles are referenced by `projects/<project>/roles/<id>`, which also orders
each grant after its role.

## Modules

* `gcs`: private bucket named `<stack>-<project>-blob` (uniform access, public access prevention
  enforced, no versioning, no soft delete), lifecycle rules that mirror the S3 module, and custom roles
  `read` (`storage.objects.get`), `list` (`storage.objects.list`), `write` (`create` and `delete`, since an
  overwrite deletes) and `delete`, bound on the bucket. No staging prefix.
* `pubsub`: topics `<stack>-<physical>` and, with a dead-letter queue, `<stack>-<physical>-dlq` plus a
  retaining pull subscription of the same name (14 days, never expires). The push subscription name
  `projects/<project>/subscriptions/<stack>-<physical>` is only reserved here; `cloud-run-app` creates it.
  `produce` binds `roles/pubsub.publisher` on the topic; `consume` is empty because push uses `run.invoker`.
* `firestore`: one native Standard database per purpose (`<stack>-store`, `<stack>-kv`), with composite
  indexes, field exemptions and TTL policies from the adapters. The location is required and immutable.
  Custom roles `read`, `write` and `delete` (`datastore.databases.get` for transactions) are bound at the project
  with the condition `resource.name == "projects/<project>/databases/<id>"`, so the store role cannot reach
  the KV database and the reverse. `metadata-delete` is the `delete` role. Creating many indexes at once can hit
  Firestore's concurrent index limit; apply with `-parallelism=1` if it does.
* `cloudsql-iam-access`: existing instance only. `roles/cloudsql.instanceUser` (and `roles/cloudsql.client`
  for the unix socket), conditioned on the instance. The login grant carries `iam_database_user`, so
  `cloud-run-app` creates one `CLOUD_IAM_SERVICE_ACCOUNT` user per function service account (named without
  `.gserviceaccount.com`). SQL privileges for those users are the bootstrap role's job, not Terraform's.
* `cloud-run-app`: a service account and a `google_cloud_run_v2_service` per function (the Cloud SQL
  socket volume only where bindings name an instance), `custom_audiences` set to the OIDC audience,
  `allUsers` invoker on HTTP ingest and API only, the push and scheduler service accounts (created from their
  ids) as invoker only on the services they trigger, push subscriptions (OIDC, ack deadline, retry policy,
  dead-letter policy, ordering) under the reserved names, the Pub/Sub service agent grants dead-lettering needs,
  Cloud Scheduler jobs, secret accessor per declared secret, and a custom role limited by name for the bootstrap
  secret. Outputs `ingest_url`, `api_url`, `bootstrap_url` (empty when the role is absent).
  The service agent address derives from the project number because `google_project_service_identity` is
  beta-only; the agent exists once the Pub/Sub API is enabled.
* `artifact-registry`: optional and operator-owned (GCP_PLAN D12), not referenced by any generated root.

Output shapes are pinned in `output-shapes.json` and compared by `pnpm infra:validate`.
