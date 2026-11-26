import {
  CONSUMER_MAX_MISSING_ATTEMPTS,
  configReference,
  type DeploymentFunction,
  type InfraDescriptor,
  type InfraValue,
  type PlatformManifest,
  type PlatformSelection,
  stackValue,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";

/** Env binding names the platform delivers to every function that needs them. */
export const OIDC_AUDIENCE_ENV = "ERRTRAQ_OIDC_AUDIENCE";
export const PUSH_SERVICE_ACCOUNT_ENV = "ERRTRAQ_PUSH_SERVICE_ACCOUNT";
export const SCHEDULER_SERVICE_ACCOUNT_ENV =
  "ERRTRAQ_SCHEDULER_SERVICE_ACCOUNT";
export const INGEST_RATE_LIMIT_ENV = "ERRTRAQ_INGEST_RATE_LIMIT";
export const BOOTSTRAP_SECRET_ENV = "ERRTRAQ_BOOTSTRAP_SECRET_NAME";
/** Internal routes of every function; the path carries what the platform needs to dispatch. */
export const PUSH_ROUTE_PREFIX = "/_errtraq/push/";
export const CRON_ROUTE_PREFIX = "/_errtraq/cron/";
export const BOOTSTRAP_ROUTE = "/_errtraq/bootstrap";
export const HEALTH_ROUTE = "/_errtraq/health";

/**
 * Provisional limits and defaults (GCP_PLAN D1, D2, D12 await the owner). Each is one value here
 * so a different answer is a local change.
 */
/** Service account ids are 6 to 30 characters; `<stack>-<function id>` must fit unless the module shortens it. */
export const MAX_STACK_NAME_LENGTH = 20;
export const FUNCTION_DEFAULTS = {
  memoryMb: 512,
  cpu: 1,
  timeoutSec: 30,
  /** Concurrent requests per instance. HTTP roles are mostly waiting on I/O. */
  concurrency: 80,
  /** Consumers carry one message per request; keep the per-instance fan-out modest. */
  consumerConcurrency: 8,
  /** Scheduled jobs and the bootstrap run alone on an instance, like a Lambda invocation. */
  singleConcurrency: 1,
  minInstances: 0,
  /** Caps scale-out so Firestore and Cloud SQL connections stay bounded (GCP_PLAN 5.5). */
  maxInstances: 20,
  ingress: "all",
  vpcEgress: "private-ranges-only",
} as const;
/** Node base image of the container; the Node 22 lineage the standalone image uses. */
/** Node 26, matching the default Lambda runtime (`nodejs26.x`); bundles target `node26`. */
export const CLOUD_RUN_NODE_IMAGE = "node:26.13.1-bookworm-slim";
export const CLOUD_RUN_ESBUILD_TARGET = "node26";

const role = z.enum([
  "ingest",
  "api",
  "consumer",
  "record",
  "cron",
  "archive",
  "bootstrap",
]);
/**
 * An IAM member that may invoke the bootstrap service. Only named principals: `allUsers` and
 * `allAuthenticatedUsers` would expose a service that runs migrations and mints API tokens.
 */
export const OPERATOR_MEMBER =
  /^(?:(?:user|group|serviceAccount):[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|domain:[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;
const accountId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
/** An image pinned by digest (literals only; a stack variable may carry any reference). */
export const IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const settings = z.strictObject({
  memoryMb: z.number().int().min(128).max(32768).optional(),
  cpu: z.number().min(0.08).max(8).optional(),
  timeoutSec: z.number().int().min(1).max(3600).optional(),
  concurrency: z.number().int().min(1).max(1000).optional(),
  minInstances: z.number().int().min(0).max(1000).optional(),
  maxInstances: z.number().int().min(1).max(1000).optional(),
  ingress: z
    .enum(["all", "internal", "internal-and-cloud-load-balancing"])
    .optional(),
  vpcEgress: z.enum(["private-ranges-only", "all-traffic"]).optional(),
});
export const configSchema = z
  .strictObject({
    /** Required, never defaulted (D8). */
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    /** Required, never defaulted (D7). */
    region: z.string().regex(/^[a-z]+-[a-z]+[0-9]+$/),
    roles: z.array(role).min(1).default(["ingest", "api", "consumer", "cron"]),
    split: z.array(role).default(["ingest", "api", "consumer", "cron"]),
    http: z.array(z.enum(["ingest", "api"])).default(["ingest", "api"]),
    settings: z.partialRecord(role, settings).default({}),
    /** Container image of every function (built by `errtraq build`, pushed by the operator, D12). */
    image: configReference(z.string().regex(IMAGE_REFERENCE)),
    /** Optional Direct VPC egress network; per-role `vpcEgress` selects how much traffic uses it. */
    vpc: z
      .strictObject({
        network: z.string().min(1),
        subnetwork: z.string().min(1),
      })
      .optional(),
    rateLimit: z.number().int().positive().safe().nullable().default(60),
    /**
     * The audience of the OIDC tokens Pub/Sub and Cloud Scheduler attach. Not a URL: Cloud Run's
     * own check accepts it through the service's custom audiences, and the handler verifies it
     * again. Fixed here so the function does not depend on its own URL (a module cycle).
     */
    oidcAudience: z.string().min(1).max(256).default("errtraq-push"),
    /** Account ids (not emails) of the invoker identities the platform module creates. */
    pushServiceAccountId: accountId.default("errtraq-push"),
    schedulerServiceAccountId: accountId.default("errtraq-scheduler"),
    cronRetryCount: z.number().int().min(0).max(5).default(3),
    /** Secret Manager secret id the optional `bootstrap` role creates (DSN and first API token). */
    bootstrapSecretName: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,255}$/)
      .optional(),
    /**
     * IAM members (`user:`, `group:`, `serviceAccount:`, `domain:`) granted `roles/run.invoker` on
     * the private bootstrap service. Empty leaves the service invocable by nobody.
     */
    operatorMembers: z.array(z.string().regex(OPERATOR_MEMBER)).default([]),
  })
  .refine(
    (config) =>
      config.operatorMembers.length === 0 || config.roles.includes("bootstrap"),
    { message: "operatorMembers is only valid with the bootstrap role" },
  )
  .refine(
    (config) =>
      config.roles.includes("bootstrap") ===
      (config.bootstrapSecretName !== undefined),
    {
      message:
        "bootstrapSecretName is required with the bootstrap role and invalid without it",
    },
  )
  .transform((config) => ({
    ...config,
    settings: {
      ...config.settings,
      consumer: { timeoutSec: 30, ...config.settings.consumer },
      ...(config.roles.includes("record")
        ? { record: { timeoutSec: 30, ...config.settings.record } }
        : {}),
      ...(config.roles.includes("bootstrap")
        ? { bootstrap: { timeoutSec: 120, ...config.settings.bootstrap } }
        : {}),
    },
  }));
export type Config = z.input<typeof configSchema>;
type Resolved = z.output<typeof configSchema>;

export const manifest: PlatformManifest = {
  id: "cloud-run",
  kind: "platform",
  configSchema,
  capabilities: {},
  runtimes: ["node"],
  requires: [],
  runtime: "node",
  compute: "function",
  maxStackNameLength: MAX_STACK_NAME_LENGTH,
  // Tokens come from the metadata server; there is no filesystem persistence, but /tmp is writable.
  provides: ["writable-filesystem", "ambient-credentials"],
  // IAM role bindings (member, role, resource) are the GCP form of an IAM policy document.
  authorization: "iam",
  bindingKinds: ["env", "secret"],
  configReferenceKinds: ["env", "variable"],
  deliversConfigBindings: true,
  infrastructureConfigReferences: { image: "string" },
  // Pub/Sub ordering on the `record` queue is available, so grouped recording is the default (D13).
  groupedRecordQueues: ["queue-pubsub"],
  // A few redeliveries let the consumer acknowledge a missing claim before dead-lettering.
  minQueueDlqAttempts: CONSUMER_MAX_MISSING_ATTEMPTS,
  // The archive tier on GCP is deferred (GCP_PLAN D14).
  supportsArchive: false,
  reservedBindings: [
    "PORT",
    "K_SERVICE",
    "K_REVISION",
    "K_CONFIGURATION",
    "CLOUD_RUN_*",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GCE_METADATA_HOST",
    OIDC_AUDIENCE_ENV,
    PUSH_SERVICE_ACCOUNT_ENV,
    SCHEDULER_SERVICE_ACCOUNT_ENV,
    INGEST_RATE_LIMIT_ENV,
    BOOTSTRAP_SECRET_ENV,
  ],
};

function functionInput(
  fn: DeploymentFunction,
  config: Resolved,
): Record<string, InfraValue> {
  const s = fn.settings;
  const num = (key: string, fallback: number) =>
    typeof s[key] === "number" ? (s[key] as number) : fallback;
  const text = (key: string, fallback: string) =>
    typeof s[key] === "string" ? (s[key] as string) : fallback;
  const consumes = fn.roles.includes("consumer") || fn.roles.includes("record");
  const alone = fn.roles.every(
    (item) => item === "cron" || item === "bootstrap",
  );
  const environment: Record<string, InfraValue> = Object.fromEntries(
    fn.envBindings.map((item) => [item.binding.name, item.binding.value]),
  );
  environment[OIDC_AUDIENCE_ENV] = config.oidcAudience;
  environment[PUSH_SERVICE_ACCOUNT_ENV] = pushEmail(config);
  environment[SCHEDULER_SERVICE_ACCOUNT_ENV] = schedulerEmail(config);
  if (fn.http.includes("ingest"))
    environment[INGEST_RATE_LIMIT_ENV] =
      config.rateLimit === null ? "disabled" : String(config.rateLimit);
  if (fn.roles.includes("bootstrap") && config.bootstrapSecretName)
    environment[BOOTSTRAP_SECRET_ENV] = config.bootstrapSecretName;
  return {
    roles: fn.roles,
    http: fn.http,
    // `public` services accept unauthenticated requests (the app authenticates DSN keys and
    // tokens, the posture of a Lambda URL with auth NONE); all other services require IAM.
    public: fn.http.length > 0,
    command: ["node", `/app/${fn.id}/index.mjs`],
    memory_mb: num("memoryMb", FUNCTION_DEFAULTS.memoryMb),
    cpu: num("cpu", FUNCTION_DEFAULTS.cpu),
    timeout_sec: num("timeoutSec", FUNCTION_DEFAULTS.timeoutSec),
    concurrency: num(
      "concurrency",
      alone
        ? FUNCTION_DEFAULTS.singleConcurrency
        : consumes
          ? FUNCTION_DEFAULTS.consumerConcurrency
          : FUNCTION_DEFAULTS.concurrency,
    ),
    min_instances: num("minInstances", FUNCTION_DEFAULTS.minInstances),
    max_instances: num("maxInstances", FUNCTION_DEFAULTS.maxInstances),
    ingress: text("ingress", FUNCTION_DEFAULTS.ingress),
    vpc_egress: text("vpcEgress", FUNCTION_DEFAULTS.vpcEgress),
    environment,
    secrets: Object.fromEntries(
      fn.secretBindings.map((item) => [item.binding.name, item.binding.value]),
    ),
    // GCP IAM binding documents ({ role, resource, condition? } lists), one output per grant.
    policies: fn.policies.flatMap((grant) =>
      grant.policyOutput ? [grant.policyOutput] : [],
    ),
    secret_reads: fn.secretReads.map((item) => item.identifier),
  };
}
const pushEmail = (config: Resolved) =>
  `${config.pushServiceAccountId}@${config.projectId}.iam.gserviceaccount.com`;
const schedulerEmail = (config: Resolved) =>
  `${config.schedulerServiceAccountId}@${config.projectId}.iam.gserviceaccount.com`;

export const infra: InfraDescriptor<Config> = {
  module: {
    // The HCL module is infra/modules/google/cloud-run-app; this descriptor is its contract.
    provider: "google",
    component: "cloud-run-app",
    outputs: {
      ingest_url: "string",
      api_url: "string",
      bootstrap_url: "string",
      service_account_emails: { map: "string" },
    },
  },
  inputs: (input, deployment): Record<string, InfraValue> => {
    const config = configSchema.parse(input);
    return {
      name: stackValue("name"),
      labels: stackValue("tags"),
      project_id: config.projectId,
      region: config.region,
      image: config.image,
      ...(config.vpc
        ? {
            vpc_network: config.vpc.network,
            vpc_subnetwork: config.vpc.subnetwork,
          }
        : {}),
      oidc_audience: config.oidcAudience,
      operator_members: config.operatorMembers,
      push_service_account_id: config.pushServiceAccountId,
      scheduler_service_account_id: config.schedulerServiceAccountId,
      functions: Object.fromEntries(
        deployment.functions.map((fn) => [fn.id, functionInput(fn, config)]),
      ),
      // One push subscription per physical queue. The module creates it under exactly the
      // reserved `subscription` name (see queue-pubsub's resources), pushing to
      // `<service url>/_errtraq/push/<physical>` with an OIDC token of the push service account.
      // The topic and dead-letter topic names follow the pubsub module's naming contract
      // (`<stack>-<physical>` and `<stack>-<physical>-dlq`, derived from the subscription name).
      queue_triggers: Object.fromEntries(
        deployment.triggers
          .filter((trigger) => trigger.kind === "queue")
          .map((trigger) => {
            const ack = trigger.settings.visibilityTimeoutSec;
            if (ack === undefined)
              throw new Error(
                `Queue ${trigger.physical} requires an ack deadline for Cloud Run`,
              );
            return [
              trigger.physical,
              {
                function_id: trigger.functionId,
                subscription: trigger.resource,
                topics: trigger.topics,
                push_path: `${PUSH_ROUTE_PREFIX}${trigger.physical}`,
                ack_deadline_sec: ack,
                ordered: trigger.topics.includes("record"),
                ...(trigger.settings.retryBackoffSec
                  ? {
                      min_backoff_sec: trigger.settings.retryBackoffSec.min,
                      max_backoff_sec: trigger.settings.retryBackoffSec.max,
                    }
                  : {}),
                dlq_enabled: trigger.settings.dlq?.enabled === true,
                ...(trigger.settings.dlq?.maxReceiveCount === undefined
                  ? {}
                  : {
                      max_delivery_attempts:
                        trigger.settings.dlq.maxReceiveCount,
                    }),
              },
            ];
          }),
      ),
      // Cloud Scheduler jobs in UTC; each calls `<service url>/_errtraq/cron/<job>` with an OIDC
      // token of the scheduler service account.
      cron_triggers: Object.fromEntries(
        deployment.triggers
          .filter((trigger) => trigger.kind === "cron")
          .map((trigger) => [
            trigger.name,
            {
              function_id: trigger.functionId,
              schedule: trigger.schedule,
              time_zone: "UTC",
              path: `${CRON_ROUTE_PREFIX}${trigger.name}`,
              retry_count: config.cronRetryCount,
            },
          ]),
      ),
    };
  },
  bindings: [],
  capabilities: {},
  resources: {},
};

export function cloudRun(config: Config): PlatformSelection {
  return {
    manifest,
    infra,
    config: configSchema.parse(config),
    runtimeModule: "@moriyoshi/errtraq-platform-cloud-run",
  };
}
export {
  pushEmail as pushServiceAccountEmail,
  schedulerEmail as schedulerServiceAccountEmail,
};
