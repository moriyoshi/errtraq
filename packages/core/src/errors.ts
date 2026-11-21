export class UnsupportedQueryError extends Error {
  override name = "UnsupportedQueryError";
}
export class VersionConflictError extends Error {
  override name = "VersionConflictError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class InvalidCursorError extends Error {
  override name = "InvalidCursorError";
}

/** A distinct record already owns a unique natural key. */
export class ConflictError extends Error {
  override name = "ConflictError";
}

/** Blob backend failures carry the provider's error code where one is available. */
export class BlobError extends Error {
  override name = "BlobError";
  constructor(
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
  }
}

/** Stored blob bytes or metadata are corrupt. */
export class BlobCorruptError extends BlobError {
  override name = "BlobCorruptError";
}

/** KV counter contains a non-decimal or unsafe integer. */
export class InvalidCounterError extends Error {
  override name = "InvalidCounterError";
}

/** Database schema is newer than this implementation understands. */
export class UnsupportedSchemaVersionError extends Error {
  override name = "UnsupportedSchemaVersionError";
}

export class BlobAccessDeniedError extends BlobError {
  override name = "BlobAccessDeniedError";
}
export class BlobThrottledError extends BlobError {
  override name = "BlobThrottledError";
}
export class BlobPreconditionError extends BlobError {
  override name = "BlobPreconditionError";
}
export class BlobInvalidKeyError extends BlobError {
  override name = "BlobInvalidKeyError";
}
export class BlobUnavailableError extends BlobError {
  override name = "BlobUnavailableError";
}
export class BlobBucketNotFoundError extends BlobError {
  override name = "BlobBucketNotFoundError";
}
