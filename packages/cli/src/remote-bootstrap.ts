import { AwsRequestError, awsRequest } from "@moriyoshi/errtraq-aws-signing";
import {
  deriveDeployment,
  type ProjectRateLimits,
  REMOTE_BOOTSTRAP_VERSION,
  type RemoteBootstrapRequest,
  type RemoteBootstrapResponse,
  type StackConfig,
} from "@moriyoshi/errtraq-core";
import { assertProjectLimitsAllowed } from "./project-limits.js";

const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Lambda never returns the secret, but also never trust provider text to be free of one. */
const SAFE_TYPE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/**
 * The deployed bootstrap function: Terraform names each function `<stack>-<function id>` and
 * the bootstrap role always has its own function. `override` serves a renamed deployment.
 */
export function bootstrapFunctionName(
  stack: StackConfig,
  override?: string,
): string {
  if (stack.platform.manifest.id !== "aws-lambda")
    throw new Error("Remote bootstrap requires an AWS Lambda stack");
  const fn = deriveDeployment(stack).functions.find((item) =>
    item.roles.includes("bootstrap"),
  );
  if (!fn)
    throw new Error(
      'This stack does not deploy the bootstrap role; add "bootstrap" to the platform roles (and a bootstrapSecretName), redeploy, or bootstrap directly without --remote',
    );
  const name = override ?? `${stack.name}-${fn.id}`;
  if (!FUNCTION_NAME.test(name))
    throw new Error("Invalid bootstrap function name");
  return name;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 2048 ? value : undefined;
}
function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Re-build the response from validated fields only; anything unexpected is rejected. */
export function parseRemoteBootstrapResponse(
  value: unknown,
): RemoteBootstrapResponse {
  const body = obj(value);
  if (!body || body.version !== REMOTE_BOOTSTRAP_VERSION)
    throw new Error("Unexpected bootstrap function response");
  if (body.ok === false) {
    const error = obj(body.error);
    const code = str(error?.code);
    const message = str(error?.message);
    if (!code || !SAFE_TYPE.test(code) || message === undefined)
      throw new Error("Unexpected bootstrap function response");
    return {
      ok: false,
      version: REMOTE_BOOTSTRAP_VERSION,
      error: { code, message },
    };
  }
  const org = obj(body.org),
    project = obj(body.project),
    key = obj(body.key),
    token = obj(body.token),
    secret = obj(body.secret);
  const retention = project?.retentionDays;
  if (
    body.ok !== true ||
    !str(org?.id) ||
    !str(org?.slug) ||
    flag(org?.created) === undefined ||
    !str(project?.id) ||
    !str(project?.slug) ||
    typeof retention !== "number" ||
    flag(project?.created) === undefined ||
    flag(key?.created) === undefined ||
    !str(token?.id) ||
    flag(token?.created) === undefined ||
    !str(secret?.arn) ||
    flag(secret?.created) === undefined
  )
    throw new Error("Unexpected bootstrap function response");
  return {
    ok: true,
    version: REMOTE_BOOTSTRAP_VERSION,
    org: {
      id: str(org?.id) as string,
      slug: str(org?.slug) as string,
      created: org?.created as boolean,
    },
    project: {
      id: str(project?.id) as string,
      slug: str(project?.slug) as string,
      retentionDays: retention,
      created: project?.created as boolean,
    },
    key: { created: key?.created as boolean },
    token: { id: str(token?.id) as string, created: token?.created as boolean },
    secret: {
      arn: str(secret?.arn) as string,
      created: secret?.created as boolean,
    },
  };
}
export interface RemoteBootstrapInput {
  orgSlug: string;
  projectSlug: string;
  ingestUrl: string;
  rateLimits?: ProjectRateLimits;
  functionName?: string;
}
/**
 * Invoke the deployed bootstrap function synchronously with the operator's AWS credentials
 * (`lambda:InvokeFunction` on that one function). The payload carries non-secret options only;
 * the DSN and API token are written to the bootstrap secret by the function itself.
 */
export async function invokeRemoteBootstrap(
  stack: StackConfig,
  environment: Readonly<Record<string, string | undefined>>,
  input: RemoteBootstrapInput,
  fetcher?: typeof fetch,
): Promise<RemoteBootstrapResponse> {
  if (input.rateLimits) assertProjectLimitsAllowed(stack, input.rateLimits);
  const functionName = bootstrapFunctionName(stack, input.functionName);
  const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  if (!region || !/^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$/.test(region))
    throw new Error("Missing or invalid AWS region");
  const payload: RemoteBootstrapRequest = {
    version: REMOTE_BOOTSTRAP_VERSION,
    orgSlug: input.orgSlug,
    projectSlug: input.projectSlug,
    ingestUrl: input.ingestUrl,
    ...(input.rateLimits && Object.keys(input.rateLimits).length
      ? { rateLimits: input.rateLimits }
      : {}),
  };
  let response: Response;
  try {
    response = await awsRequest({
      service: "lambda",
      region,
      url: `https://lambda.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}/2015-03-31/functions/${functionName}/invocations`,
      method: "POST",
      protocol: "json",
      headers: {
        "content-type": "application/json",
        "x-amz-invocation-type": "RequestResponse",
        "x-amz-log-type": "None",
      },
      body: JSON.stringify(payload),
      credentials: () => ({
        accessKeyId: environment.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? "",
        sessionToken: environment.AWS_SESSION_TOKEN,
      }),
      // A cold VPC function runs migrations before it answers; the bound is the client's limit.
      requestTimeoutMs: 300_000,
      overallTimeoutMs: 300_000,
      fetch: fetcher,
    });
  } catch (error) {
    // Only the sanitized code and status: never the provider text.
    if (error instanceof AwsRequestError)
      throw new Error(
        `Lambda invocation failed${error.status === undefined ? "" : ` (${error.status})`}${error.code ? `: ${error.code}` : ""}`,
      );
    throw new Error("Lambda invocation failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Unexpected bootstrap function response");
  }
  if (response.headers.get("x-amz-function-error")) {
    // An unhandled error or timeout: errorMessage can carry anything the code threw, so only
    // the error type is shown; the function's log group has the rest.
    const type = obj(body)?.errorType;
    throw new Error(
      `The bootstrap function failed${typeof type === "string" && SAFE_TYPE.test(type) ? ` (${type})` : ""}; see its CloudWatch log group`,
    );
  }
  return parseRemoteBootstrapResponse(body);
}
/** Operator-facing summary: ids, slugs and what was created, never the DSN or token. */
export function formatRemoteBootstrap(
  result: Extract<RemoteBootstrapResponse, { ok: true }>,
): string {
  const state = (created: boolean) => (created ? "created" : "already existed");
  return [
    `Organization ${result.org.slug} (${result.org.id}): ${state(result.org.created)}`,
    `Project ${result.project.slug} (${result.project.id}, retention ${result.project.retentionDays} days): ${state(result.project.created)}`,
    `Project key: ${state(result.key.created)}`,
    `Bootstrap API token ${result.token.id}: ${state(result.token.created)}`,
    `Bootstrap secret: ${state(result.secret.created)}`,
    `Bootstrap complete; read DSN and API token from Secrets Manager: ${result.secret.arn}`,
  ].join("\n");
}
