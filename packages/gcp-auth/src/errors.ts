/** Raised for every credential failure. Messages never contain key material or tokens. */
export class GcpAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GcpAuthError";
  }
}
/** Raised when a presented Google ID token does not verify. */
export class GcpTokenVerificationError extends GcpAuthError {
  constructor(message: string) {
    super(message, "invalid_token");
    this.name = "GcpTokenVerificationError";
  }
}
