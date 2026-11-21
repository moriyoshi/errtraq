/** A provider failure whose message excludes request bodies and credentials. */
export class DynamoStoreError extends Error {
  override name = "DynamoStoreError";
  constructor(
    message: string,
    readonly providerCode?: string,
    readonly retryable = false,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

export class DynamoStoreAccessDeniedError extends DynamoStoreError {
  override name = "DynamoStoreAccessDeniedError";
}
export class DynamoStoreThrottledError extends DynamoStoreError {
  override name = "DynamoStoreThrottledError";
}
export class DynamoStoreUnavailableError extends DynamoStoreError {
  override name = "DynamoStoreUnavailableError";
}

/** Reasons are deliberately non-enumerable: old images can contain user data. */
export class DynamoTransactionCanceledError extends DynamoStoreError {
  declare readonly reasons: readonly { code?: string; item?: unknown }[];
  constructor(reasons: readonly { code?: string; item?: unknown }[]) {
    super("DynamoDB transaction canceled", "TransactionCanceledException");
    Object.defineProperty(this, "reasons", {
      value: reasons,
      enumerable: false,
    });
  }
}
