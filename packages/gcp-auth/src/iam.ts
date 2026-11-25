import { base64Decode, base64Encode } from "./encoding.js";
import { GcpAuthError } from "./errors.js";
import type { BlobSigner, Fetch, TokenSource } from "./token-source.js";

export interface IamSignerOptions {
  tokenSource: TokenSource;
  /** The service account to sign as, or a lookup for it (for example the metadata server email). */
  email: string | (() => Promise<string>);
  fetch?: Fetch;
  /** Default `https://iamcredentials.googleapis.com`. */
  endpoint?: string;
  requestTimeoutMs?: number;
}
/**
 * `signBlob` through the IAM Credentials API. The caller needs `roles/iam.serviceAccountTokenCreator`
 * on the target service account (itself, for the common self-signing case).
 */
export class IamSigner implements BlobSigner {
  readonly email: string | (() => Promise<string>);
  private resolved?: Promise<string>;
  private readonly fetcher: Fetch;
  constructor(private readonly options: IamSignerOptions) {
    this.email = options.email;
    this.fetcher = options.fetch ?? fetch;
  }
  private resolveEmail(): Promise<string> {
    if (typeof this.email === "string") return Promise.resolve(this.email);
    this.resolved ??= this.email().catch((error) => {
      this.resolved = undefined;
      throw error;
    });
    return this.resolved;
  }
  async sign(payload: Uint8Array): Promise<Uint8Array> {
    const email = await this.resolveEmail();
    const token = await this.options.tokenSource.getAccessToken();
    const endpoint = (
      this.options.endpoint ?? "https://iamcredentials.googleapis.com"
    ).replace(/\/$/, "");
    let response: Response;
    try {
      response = await this.fetcher(
        `${endpoint}/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signBlob`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ payload: base64Encode(payload) }),
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
        },
      );
    } catch {
      throw new GcpAuthError("IAM Credentials is unreachable", "unavailable");
    }
    const body = (await response.json().catch(() => null)) as {
      signedBlob?: unknown;
    } | null;
    if (!response.ok)
      throw new GcpAuthError(
        `signBlob failed (${response.status})`,
        response.status === 403 || response.status === 401
          ? "denied"
          : response.status >= 500 || response.status === 429
            ? "unavailable"
            : "failed",
        response.status,
      );
    if (typeof body?.signedBlob !== "string" || !body.signedBlob)
      throw new GcpAuthError("Malformed signBlob response", "bad_response");
    return base64Decode(body.signedBlob);
  }
}
