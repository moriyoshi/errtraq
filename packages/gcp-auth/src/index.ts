import { IamSigner } from "./iam.js";
import { MetadataTokenSource } from "./metadata.js";
import { ServiceAccountTokenSource } from "./service-account.js";
import {
  type BlobSigner,
  type Clock,
  type Fetch,
  noAuthTokenSource,
  staticTokenSource,
  type TokenSource,
} from "./token-source.js";

export {
  base64Decode,
  base64Encode,
  base64UrlEncode,
  hex,
} from "./encoding.js";
export { GcpAuthError, GcpTokenVerificationError } from "./errors.js";
export { IamSigner, type IamSignerOptions } from "./iam.js";
export { decodeJwt, jwtExpiry, signJwt } from "./jwt.js";
export { type MetadataOptions, MetadataTokenSource } from "./metadata.js";
export {
  parseServiceAccountKey,
  type ServiceAccountKey,
  type ServiceAccountOptions,
  ServiceAccountTokenSource,
} from "./service-account.js";
export {
  type BlobSigner,
  type CachedToken,
  CLOUD_PLATFORM_SCOPE,
  type Clock,
  type Fetch,
  noAuthTokenSource,
  scopeKey,
  staticTokenSource,
  TokenCache,
  type TokenSource,
} from "./token-source.js";
export {
  GOOGLE_ISSUERS,
  GOOGLE_JWKS_URI,
  type GoogleIdTokenClaims,
  GoogleKeyStore,
  type VerifyIdTokenOptions,
  verifyGoogleIdToken,
} from "./verify.js";

export type GcpCredentials =
  | { mode: "metadata"; host?: string; serviceAccount?: string }
  | { mode: "service-account"; key: string }
  | { mode: "static"; token: string; idToken?: string }
  | { mode: "none" };
export interface Credentials {
  tokens: TokenSource;
  /** Signs blobs for V4 signed URLs: locally with a key, else through IAM Credentials. */
  signer?: BlobSigner;
}
/**
 * Resolve one credential mode to a token source and, where possible, a signer. `static` and `none`
 * (emulators and tests) have no signer.
 */
export function createCredentials(
  credentials: GcpCredentials,
  options: { fetch?: Fetch; clock?: Clock; iamEndpoint?: string } = {},
): Credentials {
  switch (credentials.mode) {
    case "metadata": {
      const tokens = new MetadataTokenSource({
        ...options,
        host: credentials.host,
        serviceAccount: credentials.serviceAccount,
      });
      return {
        tokens,
        signer: new IamSigner({
          tokenSource: tokens,
          email: () => tokens.serviceAccountEmail(),
          fetch: options.fetch,
          endpoint: options.iamEndpoint,
        }),
      };
    }
    case "service-account": {
      const tokens = new ServiceAccountTokenSource({
        ...options,
        key: credentials.key,
      });
      return { tokens, signer: tokens };
    }
    case "static":
      return {
        tokens: staticTokenSource(credentials.token, credentials.idToken),
      };
    case "none":
      return { tokens: noAuthTokenSource() };
  }
}
