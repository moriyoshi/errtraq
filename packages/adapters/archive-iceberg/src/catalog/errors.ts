/** The REST error envelope: `{ error: { message, type, code, stack? } }`. */
export interface CatalogErrorBody {
  message?: string;
  type?: string;
  code?: number;
  stack?: string[];
}
export interface CatalogErrorInit {
  operation: string;
  status: number;
  /** The decoded error object when the server sent the REST envelope. */
  body?: CatalogErrorBody;
  /** The raw response text, kept when the body was not the REST envelope. */
  rawBody?: string;
}
/** A catalog request failed. `retryable` is true only when repeating the same call is safe. */
export class CatalogError extends Error {
  override name = "CatalogError";
  readonly operation: string;
  readonly status: number;
  readonly body: CatalogErrorBody | undefined;
  readonly rawBody: string | undefined;
  readonly retryable: boolean = false;
  constructor(init: CatalogErrorInit, message?: string) {
    super(
      message ??
        `Iceberg catalog ${init.operation} failed (${init.status})${init.body?.type ? `: ${init.body.type}` : ""}${init.body?.message ? `: ${init.body.message}` : ""}`,
    );
    this.operation = init.operation;
    this.status = init.status;
    this.body = init.body;
    this.rawBody = init.rawBody;
  }
}
/** 401 / 403, or a token endpoint that refused the credentials. */
export class CatalogAuthError extends CatalogError {
  override name = "CatalogAuthError";
}
/** 404: the namespace, table or warehouse does not exist. */
export class CatalogNotFoundError extends CatalogError {
  override name = "CatalogNotFoundError";
}
/** 409 outside a commit: the namespace or table already exists. */
export class CatalogAlreadyExistsError extends CatalogError {
  override name = "CatalogAlreadyExistsError";
}
/**
 * 409 on a table commit (CommitFailedException): a requirement did not hold because another
 * writer committed first. Reload the table, rebuild the requirements and retry.
 */
export class CatalogCommitConflictError extends CatalogError {
  override name = "CatalogCommitConflictError";
  override readonly retryable: boolean = true;
}
/**
 * 500, 502, 503 or 504 on a table commit (CommitStateUnknownException): the commit may or may
 * not have been applied. It is not retryable blindly; reload the table and compare.
 */
export class CatalogCommitStateUnknownError extends CatalogError {
  override name = "CatalogCommitStateUnknownError";
}
/** Throttling or a transient server failure outside a commit; safe to repeat. */
export class CatalogTransientError extends CatalogError {
  override name = "CatalogTransientError";
  override readonly retryable: boolean = true;
}
/** 400 and other client errors, and non-transient server errors. */
export class CatalogRequestError extends CatalogError {
  override name = "CatalogRequestError";
}
/** The response was not the JSON the REST spec describes. */
export class CatalogProtocolError extends CatalogError {
  override name = "CatalogProtocolError";
}
