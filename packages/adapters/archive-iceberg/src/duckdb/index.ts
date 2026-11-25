// The DuckDB engine of archive-iceberg, exposed as the `./duckdb` subpath so that bundles that do
// not use it never import `@duckdb/node-api`. Node-only (native binding).
import type { CreateContext } from "@moriyoshi/errtraq-core";
import type { ArchiveIcebergBindings, AwsCredentials } from "../runtime.js";
import { type Config, configSchema } from "../stack.js";
import { openDuckDbSession } from "./engine.js";
import {
  EngineConfigurationError,
  type S3Credentials,
  type SessionFactory,
} from "./session.js";
import { DuckDbArchiveStore } from "./store.js";

export {
  attachSql,
  EXTENSIONS,
  instanceOptions,
  s3SecretSql,
} from "./attach.js";
export { openDuckDbSession } from "./engine.js";
export * from "./session.js";
export * from "./sql.js";
export { backoffDelay, DuckDbArchiveStore, isCommitConflict } from "./store.js";

export type DuckDbArchiveStoreInstance = DuckDbArchiveStore;

/**
 * `create` for the DuckDB-backed ArchiveStore (the same signature as the package's main-entry
 * `create`, which has no engine). Credentials for the S3 secret resolve, in order, from the
 * configured secret identifiers, the `awsCredentials` binding, then `AWS_*` in the environment.
 */
export function create({
  config,
  bindings,
  secretSource,
  environment,
}: CreateContext<Config, ArchiveIcebergBindings>): DuckDbArchiveStore {
  const parsed = configSchema.parse(config);
  const { engine, catalog } = parsed;
  const env = environment ?? process.env;
  const region =
    engine.s3.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
  const credentials = async (): Promise<S3Credentials | undefined> => {
    const { accessKeyIdSecret, secretAccessKeySecret, sessionTokenSecret } =
      engine.s3;
    if (accessKeyIdSecret || secretAccessKeySecret) {
      if (!accessKeyIdSecret || !secretAccessKeySecret)
        throw new EngineConfigurationError(
          "archive-iceberg: engine.s3 needs both accessKeyIdSecret and secretAccessKeySecret",
        );
      if (!secretSource)
        throw new EngineConfigurationError(
          "archive-iceberg: engine.s3 secrets need a secret source",
        );
      const sessionToken = sessionTokenSecret
        ? await secretSource.read(sessionTokenSecret)
        : undefined;
      return {
        accessKeyId: await secretSource.read(accessKeyIdSecret),
        secretAccessKey: await secretSource.read(secretAccessKeySecret),
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
    if (bindings?.awsCredentials) {
      const value: AwsCredentials = await bindings.awsCredentials();
      return value;
    }
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN
          ? { sessionToken: env.AWS_SESSION_TOKEN }
          : {}),
      };
    return undefined;
  };
  const openSession: SessionFactory = () =>
    openDuckDbSession({ catalog, engine, credentials, region });
  return new DuckDbArchiveStore({
    namespace: parsed.namespace,
    engine,
    openSession,
  });
}
