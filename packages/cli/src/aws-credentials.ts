import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { loadSharedConfigFiles } from "@smithy/shared-ini-file-loader";

/** The subset of an SDK credential identity the CLI forwards to the signer. */
export interface OperatorCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export type OperatorCredentialsProvider = () => Promise<OperatorCredentials>;
export interface OperatorAwsOptions {
  /** Defaults to the SDK's Node provider chain (env, SSO, shared files, credential_process, ...). */
  credentials?: OperatorCredentialsProvider;
  /** Defaults to the selected profile's `region` in the shared config file. */
  profileRegion?: () => Promise<string | undefined>;
  /** Throw (sanitized) when no credentials resolve; otherwise leave the environment unchanged. */
  required?: boolean;
}
type Environment = Readonly<Record<string, string | undefined>>;

async function configuredRegion(
  environment: Environment,
): Promise<string | undefined> {
  try {
    const files = await loadSharedConfigFiles();
    const profile = environment.AWS_PROFILE || "default";
    const region = files.configFile[profile]?.region;
    return typeof region === "string" ? region : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Operator-machine (CLI only) AWS resolution. Explicit `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` win, exactly as the SDK chain orders them; otherwise the SDK chain
 * resolves the operator's profile (`AWS_PROFILE`, SSO, `credential_process`, assume-role, ...).
 * The result is an environment with the resolved credentials and region filled in, so every
 * environment-reading adapter the CLI constructs signs with them. Deployed Lambda code never
 * calls this and keeps using the credentials Lambda provides.
 */
export async function resolveOperatorAwsEnvironment(
  environment: Environment,
  options: OperatorAwsOptions = {},
): Promise<Environment> {
  const resolved: Record<string, string | undefined> = { ...environment };
  if (!resolved.AWS_REGION && !resolved.AWS_DEFAULT_REGION) {
    const region = await (
      options.profileRegion ?? (() => configuredRegion(environment))
    )();
    if (region) resolved.AWS_REGION = region;
  }
  if (environment.AWS_ACCESS_KEY_ID && environment.AWS_SECRET_ACCESS_KEY)
    return resolved;
  try {
    const provider = options.credentials ?? fromNodeProviderChain();
    const credentials = await provider();
    if (!credentials.accessKeyId || !credentials.secretAccessKey)
      throw new Error();
    resolved.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    resolved.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    resolved.AWS_SESSION_TOKEN = credentials.sessionToken;
  } catch {
    // Never surface provider text: it can name profiles, files, or SSO details.
    if (options.required)
      throw new Error(
        "Unable to resolve AWS credentials; set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or select a profile with AWS_PROFILE (run `aws sso login` for SSO profiles)",
      );
  }
  return resolved;
}
