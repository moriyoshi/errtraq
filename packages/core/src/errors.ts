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

/** Stored blob bytes or metadata are corrupt. */
export class BlobCorruptError extends Error {
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
