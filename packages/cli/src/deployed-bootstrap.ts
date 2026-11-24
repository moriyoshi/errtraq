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

export { awsBootstrapVault };

import { assertProjectLimitsAllowed } from "./project-limits.js";

export interface DeployedDependencies {
  loadModule: DeployedModuleLoader;
  secretSource: SecretSource;
  vault: BootstrapVault;
}
/** Construct only the deployed store and KV with the operator's environment and credentials. */
export async function openDeployedStack(
  stack: StackConfig,
  environment: Readonly<Record<string, string | undefined>>,
  dependencies?: Partial<
    Pick<DeployedDependencies, "loadModule" | "secretSource">
  >,
): Promise<{ store: ActiveStore; kv: KV; close(): Promise<void> }> {
  if (stack.platform.manifest.id !== "aws-lambda")
    throw new Error(
      "Deployed operator commands currently require an AWS Lambda stack",
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
  const secretSource =
    dependencies?.secretSource ?? createSecretsManagerSource({ environment });
  const built = await constructDeployedPlan(
    plan,
    environment,
    dependencies?.loadModule ?? ((name) => import(name)),
    undefined,
    secretSource,
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
