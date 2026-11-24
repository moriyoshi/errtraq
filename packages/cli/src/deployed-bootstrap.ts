import { AwsRequestError, awsRequest } from "@errtraq/aws-signing";
import {
  type ActiveStore,
  type BootstrapVault,
  bootstrapDeployed,
  constructDeployedPlan,
  type DeployedModuleLoader,
  deployedPlan,
  deriveDeployment,
  type KV,
  type SecretSource,
  type StackConfig,
} from "@errtraq/core";
import {
  createSecretsManagerSource,
  SecretReadError,
} from "@errtraq/platform-aws-lambda/handler";

export function awsBootstrapVault(
  environment: Readonly<Record<string, string | undefined>>,
  fetcher?: typeof fetch,
): BootstrapVault {
  const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Missing AWS region");
  const source = createSecretsManagerSource({
    environment,
    fetch: fetcher,
    ttlMs: 0,
  });
  const request = async (
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    try {
      const response = await awsRequest({
        service: "secretsmanager",
        region,
        url: `https://secretsmanager.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}/`,
        method: "POST",
        protocol: "json",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `secretsmanager.${action}`,
        },
        body: JSON.stringify(input),
        credentials: () => ({
          accessKeyId: environment.AWS_ACCESS_KEY_ID ?? "",
          secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? "",
          sessionToken: environment.AWS_SESSION_TOKEN,
        }),
        fetch: fetcher,
      });
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value as Record<string, unknown>;
    } catch (error) {
      if (
        error instanceof AwsRequestError &&
        (error.code === "ResourceExistsException" ||
          error.code === "ResourceNotFoundException")
      )
        throw error;
      throw new Error("Secrets Manager bootstrap operation failed");
    }
  };
  return {
    async claim(name, candidate) {
      try {
        const created = await request("CreateSecret", {
          Name: name,
          SecretString: candidate,
          ClientRequestToken: crypto.randomUUID(),
        });
        if (typeof created.ARN !== "string")
          throw new Error("Invalid secret ARN");
        return { identifier: created.ARN, value: candidate };
      } catch (error) {
        if (
          !(error instanceof AwsRequestError) ||
          error.code !== "ResourceExistsException"
        )
          throw new Error("Unable to create bootstrap secret");
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const description = await request("DescribeSecret", {
            SecretId: name,
          });
          if (typeof description.ARN !== "string")
            throw new Error("Invalid secret ARN");
          return {
            identifier: description.ARN,
            value: await source.read(description.ARN),
          };
        } catch (error) {
          const missing =
            error instanceof AwsRequestError
              ? error.code === "ResourceNotFoundException"
              : error instanceof SecretReadError &&
                error.providerCode === "ResourceNotFoundException";
          if (!missing || attempt === 7)
            throw new Error("Unable to read bootstrap secret");
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.random() * Math.min(500, 25 * 2 ** attempt),
            ),
          );
        }
      }
      throw new Error("Unable to read bootstrap secret");
    },
  };
}
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
  },
  dependencies?: DeployedDependencies,
): Promise<string> {
  const opened = await openDeployedStack(stack, environment, dependencies);
  try {
    return await bootstrapDeployed({
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
