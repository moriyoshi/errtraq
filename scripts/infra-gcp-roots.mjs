import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveDeployment } from "../packages/core/dist/index.js";
import {
  generate,
  renderInfraValue,
} from "../packages/infra-gen/dist/index.js";

/**
 * Generated Google roots for `pnpm infra:validate` and `pnpm infra:mutate`. The example stacks take
 * the project, region and instance from the environment (no defaults, GCP_PLAN D7), so placeholders
 * are set before they load. Node cannot resolve the stacks' `./gcp-env.js` import to a `.ts` file,
 * so a copy with `.ts` specifiers is loaded; the stack text itself stays the single source.
 */
process.env.ERRTRAQ_GCP_PROJECT = "example-project";
process.env.ERRTRAQ_GCP_REGION = "europe-west1";
process.env.ERRTRAQ_GCP_SQL_INSTANCE = "example-sql";
const scratch = resolve(".agents-workspace/tmp");
mkdirSync(scratch, { recursive: true });
const copy = mkdtempSync(resolve(scratch, "gcp-stacks-"));
for (const file of ["gcp-env.ts", "gcp-firestore.ts", "gcp-cloudsql.ts"])
  writeFileSync(
    resolve(copy, file),
    readFileSync(resolve("stacks", file), "utf8").replace(
      /from "\.\/gcp-env\.js"/g,
      'from "./gcp-env.ts"',
    ),
  );
const load = async (file) =>
  (await import(pathToFileURL(resolve(copy, file)).href)).default;
export const gcpFixtures = {
  "gcp-firestore": await load("gcp-firestore.ts"),
  "gcp-cloudsql": await load("gcp-cloudsql.ts"),
};
export const IMAGE = `europe-west1-docker.pkg.dev/example-project/errtraq/app@sha256:${"a".repeat(64)}`;

// Expose what the module created to the root test, as the AWS probes do.
const probe = `
output "test_env" { value = { for id, service in google_cloud_run_v2_service.function : id => { for env in service.template[0].containers[0].env : env.name => env.value } } }
output "test_bindings" {
  value = { for id in keys(var.functions) : id => concat(
    [for key, member in google_project_iam_member.binding : "\${member.role}|projects/\${member.project}" if startswith(key, "\${id}|")],
    [for key, member in google_storage_bucket_iam_member.binding : "\${member.role}|projects/_/buckets/\${member.bucket}" if startswith(key, "\${id}|")],
    [for key, member in google_pubsub_topic_iam_member.binding : "\${member.role}|projects/\${member.project}/topics/\${member.topic}" if startswith(key, "\${id}|")],
  ) }
}
output "test_secret_reads" { value = { for id in keys(var.functions) : id => [for key, member in google_secret_manager_secret_iam_member.read : "projects/\${member.project}/secrets/\${member.secret_id}" if startswith(key, "\${id}|")] } }
output "test_subscriptions" { value = { for key, subscription in google_pubsub_subscription.push : key => { name = subscription.name, topic = subscription.topic, path = trimprefix(subscription.push_config[0].push_endpoint, google_cloud_run_v2_service.function[var.queue_triggers[key].function_id].uri), ordered = subscription.enable_message_ordering, dlq = try(subscription.dead_letter_policy[0].dead_letter_topic, ""), function = var.queue_triggers[key].function_id, audience = subscription.push_config[0].oidc_token[0].audience } } }
output "test_invokers" { value = { push = sort(keys(google_cloud_run_v2_service_iam_member.push)), scheduler = sort(keys(google_cloud_run_v2_service_iam_member.scheduler)), public = sort(keys(google_cloud_run_v2_service_iam_member.public)) } }
output "test_crons" { value = { for key, job in google_cloud_scheduler_job.cron : key => { schedule = job.schedule, time_zone = job.time_zone, function = var.cron_triggers[key].function_id, audience = job.http_target[0].oidc_token[0].audience, path = trimprefix(job.http_target[0].uri, google_cloud_run_v2_service.function[var.cron_triggers[key].function_id].uri) } } }
output "test_service_audiences" { value = { for id, service in google_cloud_run_v2_service.function : id => sort(tolist(service.custom_audiences)) } }
output "test_sql_users" { value = sort([for key, user in google_sql_user.iam : "\${user.instance}|\${split("|", key)[0]}"]) }
`;
const delivered = [
  "ERRTRAQ_OIDC_AUDIENCE",
  "ERRTRAQ_PUSH_SERVICE_ACCOUNT",
  "ERRTRAQ_SCHEDULER_SERVICE_ACCOUNT",
  "ERRTRAQ_INGEST_RATE_LIMIT",
  "ERRTRAQ_BOOTSTRAP_SECRET_NAME",
];
const test = `mock_provider "google" {
  mock_data "google_client_config" { defaults = { project = "example-project" } }
  mock_data "google_project" { defaults = { number = "123456789012" } }
  mock_resource "google_service_account" { defaults = { email = "mock-account@example-project.iam.gserviceaccount.com", name = "projects/example-project/serviceAccounts/mock-account@example-project.iam.gserviceaccount.com" } }
  mock_resource "google_cloud_run_v2_service" { defaults = { uri = "https://mock-abc123-ew.a.run.app" } }
}
variables {
  CLOUD_RUN_IMAGE = "${IMAGE}"
}
# A plan needs every binding document to be known: the for_each keys derive from them.
run "documents_known_at_plan" {
  command = plan
}
run "generated_root" {
  command = apply
  assert {
    condition = alltrue([for id, env in output.expected_env : alltrue([for key, value in env : lookup(module.platform.test_env[id], key, null) == value])])
    error_message = "Function environment differs from the deployment view."
  }
  assert {
    condition = alltrue([for id, env in module.platform.test_env : length(setsubtract(keys(env), setunion(keys(output.expected_env[id]), toset(${JSON.stringify(delivered)})))) == 0])
    error_message = "A function received an environment variable the deployment view does not give it."
  }
  assert {
    condition = alltrue([for id, documents in output.expected_policies : toset(module.platform.test_bindings[id]) == toset(flatten([for document in documents : [for binding in jsondecode(document) : "\${binding.role}|\${binding.resource}"]]))])
    error_message = "Function IAM bindings differ from the deployment view."
  }
  assert {
    condition = jsonencode(module.platform.test_secret_reads) == jsonencode(output.expected_secret_reads)
    error_message = "Secret accessor grants differ from the deployment view."
  }
  assert {
    condition = alltrue([for key, expected in output.expected_queues : module.platform.test_subscriptions[key].name == element(split("/", expected.subscription), 3) && module.platform.test_subscriptions[key].path == expected.path && module.platform.test_subscriptions[key].ordered == expected.ordered && module.platform.test_subscriptions[key].dlq == expected.dlq && module.platform.test_subscriptions[key].function == expected.function && module.platform.test_subscriptions[key].audience == output.expected_audience]) && toset(keys(module.platform.test_subscriptions)) == toset(keys(output.expected_queues))
    error_message = "Push subscriptions differ from the deployment view."
  }
  assert {
    condition = toset(module.platform.test_invokers.push) == toset(output.expected_push_invokers) && toset(module.platform.test_invokers.scheduler) == toset(output.expected_scheduler_invokers) && toset(module.platform.test_invokers.public) == toset(output.expected_public)
    error_message = "run.invoker bindings differ from the deployment view: allUsers only on HTTP ingest and API, the invoker identities only on the services they trigger."
  }
  assert {
    condition = alltrue([for id, audiences in module.platform.test_service_audiences : audiences == tolist([output.expected_audience])]) && alltrue([for key, job in module.platform.test_crons : job.audience == output.expected_audience])
    error_message = "Services must accept, and Pub/Sub and Scheduler must send, the configured OIDC audience."
  }
  assert {
    condition = jsonencode(module.platform.test_crons) == jsonencode(output.expected_crons)
    error_message = "Scheduler jobs differ from the deployment view."
  }
  assert {
    condition = jsonencode(module.platform.test_sql_users) == jsonencode(output.expected_sql_users)
    error_message = "Cloud SQL IAM database users differ from the deployment view."
  }
  assert {
    condition = output.ingest_url == "https://mock-abc123-ew.a.run.app" && output.api_url == "https://mock-abc123-ew.a.run.app"
    error_message = "Stack HTTP outputs must be the exposed service URLs."
  }
}
`;

export function prepareGcpRoot(parent, name, version) {
  const stack = gcpFixtures[name];
  if (!stack) throw new Error(`Unknown generated Google root fixture ${name}`);
  const target = resolve(parent, name);
  const modules = resolve(parent, `modules-${name}`);
  mkdirSync(target, { recursive: true });
  cpSync(resolve("infra/modules"), modules, { recursive: true });
  writeFileSync(resolve(modules, "google/cloud-run-app/probe.tf"), probe);
  const view = deriveDeployment(stack);
  const options = {
    outputDirectory: target,
    modulesDirectory: modules,
    generationEnv: {},
    artifactPaths: {},
  };
  const generated = generate(stack, options);
  if (generated.kind !== "terraform") throw new Error(generated.reason);
  for (const [file, content] of Object.entries(generated.files))
    writeFileSync(resolve(target, file), content);
  const providerPath = resolve(target, "providers.tf.json");
  const provider = JSON.parse(readFileSync(providerPath, "utf8"));
  provider.terraform.required_providers.google.version = `= ${version}`;
  writeFileSync(providerPath, `${JSON.stringify(provider, null, 2)}\n`);
  const render = (value, owner) =>
    renderInfraValue(value, owner, stack, options);
  const env = Object.fromEntries(
    view.functions.map((fn) => [
      fn.id,
      Object.fromEntries(
        [...fn.envBindings, ...fn.secretBindings].map((b) => [
          b.binding.name,
          render(b.binding.value, b.selection),
        ]),
      ),
    ]),
  );
  const policies = Object.fromEntries(
    view.functions.map((fn) => [
      fn.id,
      fn.policies.flatMap((p) =>
        p.policyOutput ? [render(p.policyOutput, p.selection)] : [],
      ),
    ]),
  );
  const secretReads = Object.fromEntries(
    view.functions.map((fn) => [
      fn.id,
      fn.secretReads.map((item) => render(item.identifier, item.selection)),
    ]),
  );
  const queues = Object.fromEntries(
    view.triggers
      .filter((t) => t.kind === "queue")
      .map((t) => {
        const subscription = render(t.resource, "queue");
        return [
          t.physical,
          {
            subscription,
            path: `/_errtraq/push/${t.physical}`,
            function: t.functionId,
            ordered: t.topics.includes("record"),
            // The dead-letter topic is the topic name plus -dlq, derived from the subscription name.
            dlq: t.settings.dlq?.enabled
              ? `\${replace(${subscription.slice(2, -1)}, "subscriptions", "topics")}-dlq`
              : "",
          },
        ];
      }),
  );
  const invokers = (kind) => [
    ...new Set(
      view.triggers
        .filter((t) => t.kind === kind)
        .map((t) => t.functionId)
        .filter(
          (id) => !view.functions.find((fn) => fn.id === id)?.http.length,
        ),
    ),
  ];
  const crons = Object.fromEntries(
    view.triggers
      .filter((t) => t.kind === "cron")
      .map((t) => [
        t.name,
        {
          schedule: t.schedule,
          time_zone: "UTC",
          function: t.functionId,
          audience: stack.platform.config.oidcAudience,
          path: `/_errtraq/cron/${t.name}`,
        },
      ]),
  );
  const sqlUsers =
    stack.store.infra.module.component === "cloudsql-iam-access"
      ? view.functions
          .filter((fn) => fn.policies.some((p) => p.selection === "store"))
          .map(
            (fn) =>
              `${stack.store.config.instanceConnectionName.split(":").at(-1)}|${fn.id}`,
          )
          .sort()
      : [];
  const expectations = {
    expected_env: env,
    expected_policies: policies,
    expected_secret_reads: secretReads,
    expected_queues: queues,
    expected_push_invokers: invokers("queue"),
    expected_scheduler_invokers: invokers("cron"),
    expected_public: view.functions
      .filter((fn) => fn.http.length)
      .map((fn) => fn.id),
    expected_crons: crons,
    expected_sql_users: sqlUsers,
    expected_audience: stack.platform.config.oidcAudience,
  };
  writeFileSync(
    resolve(target, "expectations.tf.json"),
    `${JSON.stringify({ output: Object.fromEntries(Object.entries(expectations).map(([key, value]) => [key, { value }])) }, null, 2)}\n`,
  );
  mkdirSync(resolve(target, "tests"), { recursive: true });
  writeFileSync(resolve(target, "tests/root.tftest.hcl"), test);
  return target;
}
