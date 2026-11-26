import {
  ARCHIVE_ROLE_DEFAULTS,
  type AuthSettingsInput,
  authSettingsProblem,
  CONSUMER_MAX_MISSING_ATTEMPTS,
  configReference,
  type DeploymentFunction,
  type InfraDescriptor,
  type InfraValue,
  isEnvRef,
  isVariableRef,
  type PlatformManifest,
  type PlatformSelection,
  stackValue,
  withoutReferences,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";
import {
  BOOTSTRAP_SECRET_ENV,
  BOOTSTRAP_SECRET_NAME,
} from "./bootstrap-constants.js";

/** Lambda Node.js runtimes the builder and the lambda-app module are verified against. */
export const LAMBDA_RUNTIMES = ["nodejs22.x", "nodejs26.x"] as const;
export type LambdaRuntime = (typeof LAMBDA_RUNTIMES)[number];
export const DEFAULT_LAMBDA_RUNTIME: LambdaRuntime = "nodejs26.x";
/** esbuild target matching a Lambda runtime's Node major. */
export function lambdaEsbuildTarget(runtime: LambdaRuntime): string {
  return runtime === "nodejs22.x" ? "node22" : "node26";
}

const role = z.enum([
  "ingest",
  "api",
  "consumer",
  "record",
  "cron",
  "archive",
  "bootstrap",
]);
/** Where a container-image function finds its image: an ECR image reference, tag or digest. */
export const IMAGE_URI =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[a-f0-9]{64})$/;
/** Lambda `/tmp` size of a container-image function that runs the DuckDB engine (D6). */
export const IMAGE_EPHEMERAL_STORAGE_MB = 2048;
/** Memory of an image function that has no explicit setting (the spike's 1024 MB). */
export const IMAGE_MEMORY_MB = 1024;
/**
 * A function runs from the container image when it holds the archive role or reads the archive
 * (the API, for federated queries): both load the DuckDB engine and its baked extensions (D6).
 */
export function isImageFunction(
  fn: Pick<DeploymentFunction, "roles" | "policies">,
): boolean {
  return (
    fn.roles.includes("archive") ||
    fn.policies.some(
      (grant) =>
        grant.selection === "archive" || grant.selection.startsWith("archive."),
    )
  );
}
/** An exact CORS origin: scheme, host and optional port, no path; never a wildcard. */
const corsOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, "CORS origin must be an exact HTTP(S) origin without a path");
/** Public ingest URL (the DSN host): HTTP(S), no credentials, query or fragment; a path prefix is kept. */
const ingestPublicUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.endsWith("?") &&
      !value.endsWith("#")
    );
  } catch {
    return false;
  }
}, "Public ingest URL must be an HTTP(S) URL without credentials, query or fragment");
/** Environment variable that carries the public ingest URL to the API function. */
export const PUBLIC_INGEST_URL_ENV = "ERRTRAQ_PUBLIC_INGEST_URL";
/** Environment variable that carries the sign-in settings (JSON) to the API function. */
export const AUTH_CONFIG_ENV = "ERRTRAQ_AUTH_CONFIG";
/** Serialized sign-in settings stay well under the 4 KB Lambda environment limit. */
export const MAX_AUTH_CONFIG_BYTES = 3072;
const LAMBDA_ENVIRONMENT_LIMIT_BYTES = 4096;
const isObject = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** JSON size of the sign-in settings, with each config reference counted as a placeholder. */
function authConfigBytes(config: {
  oidc?: unknown;
  proxyAuth?: unknown;
}): number {
  const { value } = withoutReferences({
    ...(config.oidc === undefined ? {} : { oidc: config.oidc }),
    ...(config.proxyAuth === undefined ? {} : { proxy: config.proxyAuth }),
  });
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
const settings = z.strictObject({
  memoryMb: z.number().int().min(128).max(10240).optional(),
  timeoutSec: z.number().int().min(1).max(900).optional(),
  architecture: z.enum(["x86_64", "arm64"]).optional(),
  urlAuth: z.enum(["NONE", "AWS_IAM"]).optional(),
  reservedConcurrency: z.number().int().min(0).max(100000).optional(),
  /** `/tmp` size in MB (Lambda allows 512 to 10240). */
  ephemeralStorageMb: z.number().int().min(512).max(10240).optional(),
});
export const configSchema = z
  .strictObject({
    roles: z.array(role).min(1).default(["ingest", "api", "consumer", "cron"]),
    split: z.array(role).default(["ingest", "api", "consumer", "cron"]),
    http: z.array(z.enum(["ingest", "api"])).default(["ingest", "api"]),
    settings: z.partialRecord(role, settings).default({}),
    vpcSubnetIds: configReference(
      z.array(z.string().regex(/^subnet-[a-f0-9]{8}(?:[a-f0-9]{9})?$/)).max(16),
    ).default([]),
    vpcSecurityGroupIds: configReference(
      z.array(z.string().regex(/^sg-[a-f0-9]{8}(?:[a-f0-9]{9})?$/)).max(5),
    ).default([]),
    runtime: z
      .enum(LAMBDA_RUNTIMES, {
        error: `runtime must be one of ${LAMBDA_RUNTIMES.join(", ")}`,
      })
      .default(DEFAULT_LAMBDA_RUNTIME),
    handler: z.string().min(1).default("index.handler"),
    /**
     * ECR image (tag or digest) that holds every container-image function's bundle, the DuckDB
     * binding and the baked extensions (build it with `errtraq build`; the generated Terraform
     * creates the repository). Required exactly when the stack selects an archive: the
     * `archive` and `api` roles then run from the image (D6).
     */
    imageUri: configReference(z.string().regex(IMAGE_URI)).optional(),
    /** CPU architecture of the image the build produces; every image function must use it. */
    imageArchitecture: z.enum(["x86_64", "arm64"]).default("arm64"),
    rateLimit: z.number().int().positive().safe().nullable().default(60),
    artifactBucket: configReference(
      z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    ).optional(),
    cronRetryAttempts: z.number().int().min(0).max(185).default(185),
    cronMaxEventAgeSec: z.number().int().min(60).max(86400).default(86400),
    /**
     * Name of the Secrets Manager secret the optional `bootstrap` role creates with the DSN and
     * first API token. Required with that role and invalid without it: the role's IAM access is
     * limited to exactly this one secret name.
     */
    bootstrapSecretName: z.string().regex(BOOTSTRAP_SECRET_NAME).optional(),
    /**
     * The URL clients send events to (a custom domain in front of the ingest function URL, or the
     * function URL itself once known). The API puts it into the DSNs of the key list. It must come
     * from the operator, a literal or a stack variable: the function's own URL output would make
     * the function's environment depend on itself. Absent, the key list has no `dsn`.
     */
    publicIngestUrl: configReference(ingestPublicUrl).optional(),
    /**
     * Origins allowed to call the API from a browser when the UI is hosted elsewhere. They go into
     * the API function URL's CORS block (the app does not add CORS headers itself, as for ingest),
     * which needs the API in a function of its own. The bundled static site is same origin and
     * needs none.
     */
    apiCorsOrigins: configReference(
      z.array(corsOrigin).min(1).max(20),
    ).optional(),
    /**
     * Host the built web UI (a directory with `index.html`, relative to the stack file) on S3
     * behind CloudFront, with `/api/0/*` routed to the API function URL. Requires the API to be
     * exposed over HTTP. `errtraq build` copies the directory into the build output and writes the
     * asset manifest Terraform uploads from.
     */
    ui: z
      .strictObject({
        directory: z.string().min(1),
        /** Price class of the distribution; the default serves every edge location. */
        priceClass: z
          .enum(["PriceClass_100", "PriceClass_200", "PriceClass_All"])
          .default("PriceClass_100"),
      })
      .optional(),
    /**
     * OIDC Bearer JWT sign-in: claims map to an organization and scopes through `grants`. The API
     * function needs egress to the IdP unless `jwks` is inline. Delivered as
     * ERRTRAQ_AUTH_CONFIG (JSON); only `variable` references, and only for issuer, audience,
     * signer and team.
     */
    oidc: z.custom<AuthSettingsInput["oidc"]>(isObject).optional(),
    /**
     * Identity asserted by a proxy in front of the API: signed assertion headers only (Google
     * IAP, Cloudflare Access, AWS ALB, Pomerium, generic). Plain identity headers are refused:
     * a function URL with authorization NONE is reachable without the proxy.
     */
    proxyAuth: z.custom<AuthSettingsInput["proxy"]>(isObject).optional(),
    cronDlqArn: z
      .string()
      .regex(/^arn:[^:]+:sqs:/)
      .optional(),
    /** Existing operator-owned SNS topic notified by the function alarms; never created here. */
    alarmTopicArn: z
      .string()
      .regex(
        /^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/,
      )
      .optional(),
  })
  .refine(
    (config) =>
      !Array.isArray(config.vpcSubnetIds) ||
      !Array.isArray(config.vpcSecurityGroupIds) ||
      (config.vpcSubnetIds.length === 0) ===
        (config.vpcSecurityGroupIds.length === 0),
    {
      message:
        "VPC subnet IDs and security group IDs must be provided together",
    },
  )
  .superRefine((config, ctx) => {
    const problem = authSettingsProblem(config);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
    else if (
      (config.oidc !== undefined || config.proxyAuth !== undefined) &&
      !config.http.includes("api")
    )
      ctx.addIssue({
        code: "custom",
        message: "oidc and proxyAuth need the api role exposed over HTTP",
      });
    else if (authConfigBytes(config) > MAX_AUTH_CONFIG_BYTES)
      ctx.addIssue({
        code: "custom",
        message: `oidc and proxyAuth serialize to more than ${MAX_AUTH_CONFIG_BYTES} bytes; Lambda limits all environment variables together to 4 KB, so use fewer or shorter grants`,
      });
    const proxy = config.proxyAuth as { kind?: unknown } | undefined;
    if (proxy?.kind === "unsigned")
      ctx.addIssue({
        code: "custom",
        message:
          "Unsigned identity headers are not supported on AWS Lambda: a function URL with authorization NONE is reachable without the proxy, and the shared secret would sit in the function environment; use a signed assertion preset",
      });
  })
  .refine((config) => !config.ui || config.http.includes("api"), {
    message: "ui requires the api role to be exposed over HTTP",
  })
  .refine((config) => !config.ui || config.roles.includes("api"), {
    message: "ui requires the api role",
  })
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
      // Migrations plus a cold start inside the VPC; override with settings.bootstrap.
      ...(config.roles.includes("archive")
        ? {
            archive: {
              ...ARCHIVE_ROLE_DEFAULTS,
              ...config.settings.archive,
            },
          }
        : {}),
      ...(config.roles.includes("bootstrap")
        ? { bootstrap: { timeoutSec: 120, ...config.settings.bootstrap } }
        : {}),
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
  configReferenceKinds: ["env", "variable"],
  deliversConfigBindings: true,
  deliversIngestRateLimit: true,
  groupedRecordQueues: ["queue-sqs"],
  minQueueDlqAttempts: CONSUMER_MAX_MISSING_ATTEMPTS,
  infrastructureConfigReferences: {
    artifactBucket: "string",
    imageUri: "string",
    publicIngestUrl: "string",
    "oidc.issuer": "string",
    "oidc.audience": "string",
    "proxyAuth.issuer": "string",
    "proxyAuth.audience": "string",
    "proxyAuth.signer": "string",
    "proxyAuth.team": "string",
    apiCorsOrigins: "string[]",
    vpcSubnetIds: "string[]",
    vpcSecurityGroupIds: "string[]",
  },
  reservedBindings: [
    "ERRTRAQ_INGEST_RATE_LIMIT",
    BOOTSTRAP_SECRET_ENV,
    PUBLIC_INGEST_URL_ENV,
    AUTH_CONFIG_ENV,
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
/** Only variable references can reach the module; an environment reference has no meaning there. */
function assertVariableReferencesOnly(value: unknown, path: string): void {
  if (isEnvRef(value))
    throw new Error(
      `${path}: only variable references are supported in oidc and proxyAuth on Lambda`,
    );
  if (Array.isArray(value))
    value.forEach((item, i) => {
      assertVariableReferencesOnly(item, `${path}.${i}`);
    });
  else if (isObject(value) && !isVariableRef(value))
    for (const [key, item] of Object.entries(value as object))
      assertVariableReferencesOnly(item, `${path}.${key}`);
}
/** The module input for the sign-in settings, after the checks that need the deployment. */
function authConfigInput(
  config: Config,
  apiFunction: DeploymentFunction | undefined,
): Record<string, InfraValue> | undefined {
  if (config.oidc === undefined && config.proxyAuth === undefined)
    return undefined;
  if (!apiFunction)
    throw new Error("oidc and proxyAuth need the api role exposed over HTTP");
  assertVariableReferencesOnly(config.oidc, "oidc");
  assertVariableReferencesOnly(config.proxyAuth, "proxyAuth");
  // Every environment value of the function counts toward Lambda's 4 KB limit (names included).
  const known = [
    ...apiFunction.envBindings.map((item) => item.binding),
    ...apiFunction.secretBindings.map((item) => item.binding),
  ].reduce(
    (sum, binding) =>
      sum +
      binding.name.length +
      (typeof binding.value === "string" ? binding.value.length : 0),
    0,
  );
  const total =
    known +
    AUTH_CONFIG_ENV.length +
    authConfigBytes(config) +
    (config.publicIngestUrl ? PUBLIC_INGEST_URL_ENV.length + 256 : 0);
  if (total > LAMBDA_ENVIRONMENT_LIMIT_BYTES)
    throw new Error(
      `The ${apiFunction.id} function's environment would be about ${total} bytes with the sign-in settings; Lambda allows 4096 in total`,
    );
  return {
    ...(config.oidc === undefined ? {} : { oidc: config.oidc as InfraValue }),
    ...(config.proxyAuth === undefined
      ? {}
      : { proxy: config.proxyAuth as InfraValue }),
  };
}
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "aws",
    component: "lambda-app",
    outputs: {
      ingest_url: "string",
      api_url: "string",
      image_repository_url: "string",
      bootstrap_function_name: "string",
      bootstrap_function_arn: "string",
      ui_domain_name: "string",
      ui_distribution_id: "string",
      ui_bucket_name: "string",
    },
  },
  inputs: (config, deployment): Record<string, InfraValue> => {
    const images = deployment.functions.filter(isImageFunction);
    const imageArchitecture = config.imageArchitecture ?? "arm64";
    if (images.length && config.imageUri === undefined)
      throw new Error(
        `Container-image functions (${images.map((fn) => fn.id).join(", ")}) need the platform config imageUri`,
      );
    for (const fn of images)
      if (
        fn.settings.architecture !== undefined &&
        fn.settings.architecture !== imageArchitecture
      )
        throw new Error(
          `Function ${fn.id} runs from the ${imageArchitecture} image and cannot use ${fn.settings.architecture}`,
        );
    const apiFunction = deployment.functions.find((fn) =>
      fn.http.includes("api"),
    );
    if (config.apiCorsOrigins !== undefined) {
      if (!apiFunction)
        throw new Error("apiCorsOrigins needs the api role exposed over HTTP");
      // A function URL has one CORS policy for every path, and ingest's is public (any origin,
      // POST); a browser UI needs credentials-bearing headers for the API only.
      if (apiFunction.http.includes("ingest"))
        throw new Error(
          `apiCorsOrigins needs the api role in a function of its own (it shares ${apiFunction.id} with ingest); add "api" to split`,
        );
    }
    if (config.ui) {
      if (!apiFunction)
        throw new Error("ui needs the api role exposed over HTTP");
      // CloudFront cannot call an IAM-protected function URL without origin access control, which
      // would replace the user's Bearer token with its own signature.
      if (apiFunction.settings.urlAuth === "AWS_IAM")
        throw new Error(
          `ui needs the API function URL without IAM authorization (urlAuth NONE); ${apiFunction.id} uses AWS_IAM`,
        );
    }
    const authConfig = authConfigInput(config, apiFunction);
    return {
      name: stackValue("name"),
      tags: stackValue("tags"),
      // The static site reads the build copy `errtraq build` writes next to the function
      // artifacts; the module derives that directory from the API function's artifact path.
      ...(config.ui && apiFunction
        ? {
            ui: {
              build_anchor: apiFunction.artifact,
              price_class: config.ui.priceClass ?? "PriceClass_100",
            },
          }
        : {}),
      ...(config.publicIngestUrl
        ? { ingest_public_url: config.publicIngestUrl }
        : {}),
      ...(config.apiCorsOrigins
        ? { api_cors_origins: config.apiCorsOrigins }
        : {}),
      ...(authConfig ? { auth_config: authConfig } : {}),
      ...(config.alarmTopicArn
        ? { alarm_topic_arn: config.alarmTopicArn }
        : {}),
      ...(config.bootstrapSecretName
        ? { bootstrap_secret_name: config.bootstrapSecretName }
        : {}),
      ...(config.artifactBucket
        ? { artifact_bucket: config.artifactBucket }
        : {}),
      vpc_subnet_ids: config.vpcSubnetIds ?? [],
      vpc_security_group_ids: config.vpcSecurityGroupIds ?? [],
      runtime: config.runtime ?? DEFAULT_LAMBDA_RUNTIME,
      handler: config.handler ?? "index.handler",
      ...(images.length && config.imageUri !== undefined
        ? { image_uri: config.imageUri }
        : {}),
      functions: Object.fromEntries(
        deployment.functions.map((fn) => [
          fn.id,
          {
            roles: fn.roles,
            http: fn.http,
            artifact: fn.artifact,
            package_type: isImageFunction(fn) ? "Image" : "Zip",
            memory_mb:
              fn.settings.memoryMb ??
              (isImageFunction(fn) ? IMAGE_MEMORY_MB : 512),
            timeout_sec: fn.settings.timeoutSec ?? 30,
            architecture: isImageFunction(fn)
              ? imageArchitecture
              : (fn.settings.architecture ?? "x86_64"),
            ephemeral_storage_mb:
              typeof fn.settings.ephemeralStorageMb === "number"
                ? fn.settings.ephemeralStorageMb
                : isImageFunction(fn)
                  ? IMAGE_EPHEMERAL_STORAGE_MB
                  : 512,
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
    };
  },
  bindings: [],
  capabilities: {},
  resources: {},
};
export function awsLambda(config: Config = {}): PlatformSelection {
  return {
    manifest,
    infra,
    config: configSchema.parse(config),
    runtimeModule: "@moriyoshi/errtraq-platform-aws-lambda",
  };
}
