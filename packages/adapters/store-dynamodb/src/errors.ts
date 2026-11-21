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
