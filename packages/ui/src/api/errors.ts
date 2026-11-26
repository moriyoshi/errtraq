export type ApiErrorKind =
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "badRequest"
  | "conflict"
  | "server"
  | "network"
  | "parse";

/** Every failure of the API client surfaces as this error. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isApiError(
  error: unknown,
  kind?: ApiErrorKind,
): error is ApiError {
  return (
    error instanceof ApiError && (kind === undefined || error.kind === kind)
  );
}

export function kindOfStatus(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "badRequest";
  return "server";
}
