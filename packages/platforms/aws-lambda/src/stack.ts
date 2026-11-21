import {
  type InfraDescriptor,
  type PlatformManifest,
  type PlatformSelection,
  stackValue,
} from "@errtraq/core";
import { z } from "zod";

const role = z.enum(["ingest", "api", "consumer", "cron"]);
const settings = z.strictObject({
  memoryMb: z.number().int().min(128).max(10240).optional(),
  timeoutSec: z.number().int().min(1).max(900).optional(),
  architecture: z.enum(["x86_64", "arm64"]).optional(),
  urlAuth: z.enum(["NONE", "AWS_IAM"]).optional(),
  reservedConcurrency: z.number().int().min(0).max(100000).optional(),
});
export const configSchema = z
  .strictObject({
    roles: z.array(role).min(1).default(["ingest", "api", "consumer", "cron"]),
    split: z.array(role).default(["ingest", "api", "consumer", "cron"]),
    http: z.array(z.enum(["ingest", "api"])).default(["ingest", "api"]),
    settings: z.partialRecord(role, settings).default({}),
    runtime: z.string().min(1).default("nodejs22.x"),
    handler: z.string().min(1).default("index.handler"),
    cronRetryAttempts: z.number().int().min(0).max(185).default(185),
    cronMaxEventAgeSec: z.number().int().min(60).max(86400).default(86400),
    cronDlqArn: z
      .string()
      .regex(/^arn:[^:]+:sqs:/)
      .optional(),
  })
  .transform((config) => ({
    ...config,
    settings: {
      ...config.settings,
      consumer: { timeoutSec: 30, ...config.settings.consumer },
    },
  }));
export type Config = z.input<typeof configSchema>;
export const manifest: PlatformManifest = {
  id: "aws-lambda",
  kind: "platform",
  configSchema,
  capabilities: {},
  runtimes: ["node"],
  requires: [],
  runtime: "node",
  compute: "function",
  maxStackNameLength: 40,
  provides: ["writable-filesystem", "aws-credentials"],
  authorization: "iam",
  bindingKinds: ["env", "secret"],
  configReferenceKinds: [],
  reservedBindings: [
    "_HANDLER",
    "_X_AMZN_TRACE_ID",
    "AWS_DEFAULT_REGION",
    "AWS_REGION",
    "AWS_EXECUTION_ENV",
    "AWS_LAMBDA_*",
    "AWS_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "LAMBDA_TASK_ROOT",
    "LAMBDA_RUNTIME_DIR",
  ],
};
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "aws",
    component: "lambda-app",
    outputs: { ingest_url: "string", api_url: "string" },
  },
  inputs: (config, deployment) => ({
    name: stackValue("name"),
    tags: stackValue("tags"),
    runtime: config.runtime ?? "nodejs22.x",
    handler: config.handler ?? "index.handler",
    functions: Object.fromEntries(
      deployment.functions.map((fn) => [
        fn.id,
        {
          roles: fn.roles,
          http: fn.http,
          artifact: fn.artifact,
          memory_mb: fn.settings.memoryMb ?? 512,
          timeout_sec: fn.settings.timeoutSec ?? 30,
          architecture: fn.settings.architecture ?? "x86_64",
          auth_type:
            typeof fn.settings.urlAuth === "string"
              ? fn.settings.urlAuth
              : "NONE",
          ...(typeof fn.settings.reservedConcurrency !== "number"
            ? {}
            : { reserved_concurrency: fn.settings.reservedConcurrency }),
          environment: Object.fromEntries(
            fn.envBindings.map((item) => [
              item.binding.name,
              item.binding.value,
            ]),
          ),
          secrets: Object.fromEntries(
            fn.secretBindings.map((item) => [
              item.binding.name,
              item.binding.value,
            ]),
          ),
          policies: fn.policies.flatMap((grant) =>
            grant.policyOutput ? [grant.policyOutput] : [],
          ),
          secret_reads: fn.secretReads.map((item) => item.identifier),
        },
      ]),
    ),
    queue_triggers: Object.fromEntries(
      deployment.triggers
        .filter((trigger) => trigger.kind === "queue")
        .map((trigger) => {
          if (trigger.settings.visibilityTimeoutSec === undefined)
            throw new Error(
              `Queue ${trigger.physical} requires a visibility timeout for Lambda`,
            );
          return [
            trigger.physical,
            {
              function_id: trigger.functionId,
              resource: trigger.resource,
              topics: trigger.topics,
              visibility_timeout_sec: trigger.settings.visibilityTimeoutSec,
              ...(trigger.settings.batchSize === undefined
                ? {}
                : { batch_size: trigger.settings.batchSize }),
              ...(trigger.settings.maxConcurrency === undefined
                ? {}
                : { max_concurrency: trigger.settings.maxConcurrency }),
            },
          ];
        }),
    ),
    cron_triggers: Object.fromEntries(
      deployment.triggers
        .filter((trigger) => trigger.kind === "cron")
        .map((trigger) => [
          trigger.name,
          {
            function_id: trigger.functionId,
            schedule: trigger.schedule,
            retry_attempts: config.cronRetryAttempts ?? 185,
            max_event_age_seconds: config.cronMaxEventAgeSec ?? 86400,
            ...(config.cronDlqArn ? { dlq_arn: config.cronDlqArn } : {}),
          },
        ]),
    ),
  }),
  bindings: [],
  capabilities: {},
  resources: {},
};
export function awsLambda(config: Config = {}): PlatformSelection {
  return {
    manifest,
    infra,
    config: configSchema.parse(config),
    runtimeModule: "@errtraq/platform-aws-lambda",
  };
}
