export class UnsupportedQueryError extends Error {
  override name = "UnsupportedQueryError";
}
export class VersionConflictError extends Error {
  override name = "VersionConflictError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}
