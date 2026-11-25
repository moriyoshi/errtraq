/** What the archive engine and its SigV4 catalog client need; structurally the adapter's `AwsCredentials`. */
export interface LambdaCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Set when the environment names an expiry; the engine then renews its S3 secret ahead of it. */
  expiration?: Date;
}

/**
 * The execution role's credentials as Lambda delivers them (`AWS_*` environment variables), read on
 * every call so a runtime that refreshes them is followed. Lambda does not publish an expiry by
 * itself; `AWS_CREDENTIAL_EXPIRATION` (an ISO 8601 time, set by some runtimes and test harnesses)
 * becomes `expiration`, and without it the engine renews only after an S3 authorization failure.
 */
export function lambdaAwsCredentials(
  environment: Readonly<Record<string, string | undefined>>,
): () => LambdaCredentials {
  return () => {
    const accessKeyId = environment.AWS_ACCESS_KEY_ID;
    const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey)
      throw new Error("Lambda execution role credentials are missing");
    const sessionToken = environment.AWS_SESSION_TOKEN;
    const raw = environment.AWS_CREDENTIAL_EXPIRATION;
    const expiration = raw ? new Date(raw) : undefined;
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      ...(expiration && !Number.isNaN(expiration.getTime())
        ? { expiration }
        : {}),
    };
  };
}
