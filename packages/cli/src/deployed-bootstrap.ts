import {
  type ActiveStore,
  type BootstrapVault,
  bootstrapDeployed,
  bootstrapRetentionPolicy,
  constructDeployedPlan,
  type DeployedModuleLoader,
  deployedPlan,
  deriveDeployment,
  type KV,
  type ProjectRateLimits,
  type SecretSource,
  type StackConfig,
} from "@moriyoshi/errtraq-core";
import {
  awsBootstrapVault,
  createSecretsManagerSource,
} from "@moriyoshi/errtraq-platform-aws-lambda/handler";
import {
  createSecretManagerSource,
  gcpAuthFromTokens,
  gcpBootstrapVault,
  gcpHostBindings,
} from "@moriyoshi/errtraq-platform-cloud-run/handler";
import {
  type OperatorGcpCredentials,
  resolveOperatorGcpCredentials,
} from "./gcp-credentials.js";

export { awsBootstrapVault };

import { assertProjectLimitsAllowed } from "./project-limits.js";

export interface DeployedDependencies {
  loadModule: DeployedModuleLoader;
  secretSource: SecretSource;
  vault: BootstrapVault;
  /** Cloud Run stacks: the operator's Google credentials (default: Application Default Credentials). */
  gcp?: OperatorGcpCredentials;
}
/** Construct only the deployed store and KV with the operator's environment and credentials. */
export async function openDeployedStack(
  stack: StackConfig,
  environment: Readonly<Record<string, string | undefined>>,
  dependencies?: Partial<
    Pick<DeployedDependencies, "loadModule" | "secretSource" | "gcp">
  >,
): Promise<{ store: ActiveStore; kv: KV; close(): Promise<void> }> {
  const platformId = stack.platform.manifest.id;
  if (platformId !== "aws-lambda" && platformId !== "cloud-run")
    throw new Error(
      "Deployed operator commands currently require an AWS Lambda or Cloud Run stack",
    );
  const fn = deriveDeployment(stack).functions.find((item) =>
    item.roles.includes("ingest"),
  );
  if (!fn) throw new Error("Stack has no ingest function");
  const plan = deployedPlan(stack, fn.id);
  plan.selections = plan.selections.filter(
    (selection) =>
      !selection.path.includes(".") &&
      (selection.kind === "store" || selection.kind === "kv"),
  );
  const storePath = plan.selections.find(
    (selection) => selection.kind === "store",
  )?.path;
  const kvPath = plan.selections.find(
    (selection) => selection.kind === "kv",
  )?.path;
  if (
    !storePath ||
    !kvPath ||
    plan.selections.length !== 2 ||
    plan.selections.some((selection) => Object.keys(selection.dependsOn).length)
  )
    throw new Error("Bootstrap requires independent store and KV selections");
  plan.queueConsumers = [];
  plan.topics = {};
  // The operator's own credentials stand in for the metadata server, in the CLI only.
  const gcp =
    platformId === "cloud-run"
      ? (dependencies?.gcp ??
        (await resolveOperatorGcpCredentials(environment)))
      : undefined;
  const secretSource =
    dependencies?.secretSource ??
    (gcp
      ? createSecretManagerSource({ tokens: gcp.tokens })
      : createSecretsManagerSource({ environment }));
  const built = await constructDeployedPlan(
    plan,
    environment,
    dependencies?.loadModule ?? ((name) => import(name)),
    undefined,
    secretSource,
    gcp
      ? gcpHostBindings(
          gcpAuthFromTokens(gcp.tokens, gcp.email),
          async () => false,
        )
      : undefined,
  );
  return {
    store: built.instances.get(storePath) as ActiveStore,
    kv: built.instances.get(kvPath) as KV,
    close: () => built.close(),
  };
}
export async function bootstrapAwsStack(
  stack: StackConfig,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    secretName: string;
    ingestUrl: string;
    orgSlug: string;
    projectSlug: string;
    /** Tighter per-project rate limits for the new project; see `project rate-limits`. */
    rateLimits?: ProjectRateLimits;
  },
  dependencies?: DeployedDependencies,
): Promise<string> {
  if (options.rateLimits) assertProjectLimitsAllowed(stack, options.rateLimits);
  const opened = await openDeployedStack(stack, environment, dependencies);
  const { retentionDays, maxRetentionDays } = bootstrapRetentionPolicy(stack);
  try {
    return await bootstrapDeployed({
      retentionDays,
      maxRetentionDays,
      rateRejection: stack.rateRejection,
      stackName: stack.name,
      store: opened.store,
      kv: opened.kv,
      vault: dependencies?.vault ?? awsBootstrapVault(environment),
      ...options,
    });
  } finally {
    await opened.close();
  }
}

/** Cloud Run: the same bootstrap, with the DSN and token kept in Secret Manager. */
export async function bootstrapCloudRunStack(
  stack: StackConfig,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    secretName: string;
    ingestUrl: string;
    orgSlug: string;
    projectSlug: string;
    rateLimits?: ProjectRateLimits;
  },
  dependencies?: Partial<DeployedDependencies>,
): Promise<string> {
  if (stack.platform.manifest.id !== "cloud-run")
    throw new Error("Expected a Cloud Run stack");
  if (options.rateLimits) assertProjectLimitsAllowed(stack, options.rateLimits);
  const gcp =
    dependencies?.gcp ?? (await resolveOperatorGcpCredentials(environment));
  const opened = await openDeployedStack(stack, environment, {
    ...dependencies,
    gcp,
  });
  const { retentionDays, maxRetentionDays } = bootstrapRetentionPolicy(stack);
  try {
    return await bootstrapDeployed({
      retentionDays,
      maxRetentionDays,
      rateRejection: stack.rateRejection,
      stackName: stack.name,
      store: opened.store,
      kv: opened.kv,
      vault:
        dependencies?.vault ??
        gcpBootstrapVault({
          projectId: (stack.platform.config as { projectId: string }).projectId,
          tokens: gcp.tokens,
        }),
      ...options,
    });
  } finally {
    await opened.close();
  }
}
