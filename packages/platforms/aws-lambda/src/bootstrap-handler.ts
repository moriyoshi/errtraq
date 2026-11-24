import {
  type ActiveStore,
  type BootstrapVault,
  type KV,
  type Logger,
  type RateRejectionConfig,
  type RemoteBootstrapResponse,
  runRemoteBootstrap,
} from "@moriyoshi/errtraq-core/runtime";
import {
  BOOTSTRAP_SECRET_ENV,
  BOOTSTRAP_SECRET_NAME,
} from "./bootstrap-constants.js";

export interface BootstrapHandlerOptions {
  stackName: string;
  store: ActiveStore;
  kv: KV;
  vault: BootstrapVault;
  /** Fixed by the deployment (see {@link bootstrapSecretName}); the invoker cannot choose it. */
  secretName: string;
  retentionDays?: number;
  maxRetentionDays?: number;
  rateRejection?: RateRejectionConfig;
  logger?: Pick<Logger, "info" | "error">;
}
/** The one secret name the function's IAM policy allows; absent or malformed is a deployment bug. */
export function bootstrapSecretName(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const name = environment[BOOTSTRAP_SECRET_ENV];
  if (!name || !BOOTSTRAP_SECRET_NAME.test(name))
    throw new Error("Missing or invalid bootstrap secret name binding");
  return name;
}
/**
 * Handler of the operator-invoked bootstrap function. The event is the request document
 * (non-secret options only); the result is a non-secret summary or a scrubbed error document.
 * The DSN and API token are written to the bootstrap secret and never returned or logged.
 */
export function createBootstrapHandler(
  options: BootstrapHandlerOptions,
): (event: unknown) => Promise<RemoteBootstrapResponse> {
  return (event) => runRemoteBootstrap(event, options);
}
