/**
 * JWT verification with WebCrypto only (no dependency), shared by the Bearer OIDC path and the
 * identity-aware proxy assertion path. Every rejection is an `AuthError`: callers answer 401 and
 * never echo the reason (it is only for tests and class-only logging).
 */

export type JwtAlgorithm = "RS256" | "ES256" | "PS256";
export const SUPPORTED_ALGORITHMS: readonly JwtAlgorithm[] = [
  "RS256",
  "ES256",
  "PS256",
];
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_FETCH_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
export const CLOCK_SKEW_SEC = 60;
export const DEFAULT_MAX_LIFETIME_SEC = 24 * 3600;
export const MIN_KEY_TTL_SEC = 300;
export const MAX_KEY_TTL_SEC = 24 * 3600;
export const MIN_REFETCH_INTERVAL_SEC = 60;
const DEFAULT_KEY_TTL_SEC = 3600;

/** Why a credential was rejected; the class is safe to log, the message is not shown to clients. */
export class AuthError extends Error {
  constructor(
    readonly reason: string,
    readonly kind: "invalid" | "unavailable" = "invalid",
  ) {
    super(reason);
    this.name = "AuthError";
  }
}

export type Claims = Record<string, unknown>;
export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  signer?: string;
  [key: string]: unknown;
}
export interface VerifiedJwt {
  header: JwtHeader;
  claims: Claims;
}
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Resolves the verification key for one token; implementations own caching and refetch limits. */
export interface KeySource {
  getKey(header: JwtHeader, alg: JwtAlgorithm): Promise<CryptoKey>;
}

export interface VerifyRules {
  /** Accepted algorithms; the token's `alg` must be in this list. */
  algorithms: readonly JwtAlgorithm[];
  /** Exact `iss` match; absent means the source does not check it (proxy presets without one). */
  issuer?: string;
  /** Required value of the audience claim (string equals, array contains). */
  audience?: string;
  /** Claim holding the audience; `aud` unless the IdP names it otherwise (`client_id`). */
  audienceClaim?: string;
  /** Required `signer` header field (AWS ALB ARN). */
  signer?: string;
  /** Required claim value, for example Cognito `token_use` = `access`. */
  tokenUse?: { claim: string; value: string };
  /** Accepted `typ` header values, compared case-insensitively. */
  typ?: readonly string[];
  maxLifetimeSec?: number;
  /** Accept standard base64 with padding as well (AWS ALB). */
  lenientBase64?: boolean;
  /** AWS ALB documents `exp` in the JWT header; use it when the payload carries none. */
  headerExpFallback?: boolean;
  /** Seconds since the epoch. */
  now: () => number;
}

const textDecoder = new TextDecoder();
/** Decode base64url (strict), or base64 / base64url with padding when lenient. */
export function decodeBase64(value: string, lenient = false): Uint8Array {
  let text = value;
  if (lenient) {
    text = text.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
  }
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw new AuthError("malformed base64");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function decodeJson(
  segment: string,
  lenient: boolean,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(decodeBase64(segment, lenient)));
  } catch {
    throw new AuthError("malformed segment");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AuthError("segment is not an object");
  return value as Record<string, unknown>;
}

/** Three non-empty-header dot separated segments: the shape of a JWT candidate. */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_=+/-]+\.[A-Za-z0-9_=+/-]+\.[A-Za-z0-9_=+/-]*$/.test(
    token,
  );
}

function verifyParams(
  alg: JwtAlgorithm,
): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  switch (alg) {
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5" };
    case "PS256":
      return { name: "RSA-PSS", saltLength: 32 } as RsaPssParams;
    case "ES256":
      return { name: "ECDSA", hash: "SHA-256" } as EcdsaParams;
  }
}
/** Import parameters for a key that will verify `alg`. */
export function importParams(alg: JwtAlgorithm) {
  switch (alg) {
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    case "PS256":
      return { name: "RSA-PSS", hash: "SHA-256" };
    case "ES256":
      return { name: "ECDSA", namedCurve: "P-256" };
  }
}

function numericDate(claims: Claims, name: string): number | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new AuthError(`${name} is not a number`);
  return value;
}
function claimContains(value: unknown, expected: string): boolean {
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}

/**
 * Verify signature and claims. The accepted algorithm list comes from configuration; the key must
 * be usable for the token's own algorithm (checked in the key source), so neither the token nor
 * the key alone decides the algorithm.
 */
export async function verifyJwt(
  token: string,
  keys: KeySource,
  rules: VerifyRules,
): Promise<VerifiedJwt> {
  if (token.length > MAX_TOKEN_BYTES) throw new AuthError("token too large");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
    throw new AuthError("not a JWT");
  const lenient = rules.lenientBase64 === true;
  const header = decodeJson(parts[0], lenient) as JwtHeader;
  if (typeof header.alg !== "string") throw new AuthError("missing alg");
  const alg = header.alg;
  if (alg.toLowerCase() === "none") throw new AuthError("alg none");
  if (alg.toUpperCase().startsWith("HS")) throw new AuthError("symmetric alg");
  if (!(rules.algorithms as readonly string[]).includes(alg))
    throw new AuthError("alg not accepted");
  if ("crit" in header) throw new AuthError("crit header");
  if (header.kid !== undefined && typeof header.kid !== "string")
    throw new AuthError("invalid kid");
  if (rules.typ?.length) {
    const typ = typeof header.typ === "string" ? header.typ.toLowerCase() : "";
    if (!rules.typ.some((t) => t.toLowerCase() === typ))
      throw new AuthError("typ not accepted");
  }
  if (rules.signer !== undefined && header.signer !== rules.signer)
    throw new AuthError("signer mismatch");
  const claims = decodeJson(parts[1], lenient);
  if (
    rules.headerExpFallback &&
    claims.exp === undefined &&
    header.exp !== undefined
  )
    claims.exp = Number(header.exp);
  let signature: Uint8Array;
  try {
    signature = decodeBase64(parts[2], lenient);
  } catch {
    throw new AuthError("malformed signature");
  }
  const key = await keys.getKey(header, alg as JwtAlgorithm);
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      verifyParams(alg as JwtAlgorithm),
      key,
      signature as BufferSource,
      signingInput,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthError("bad signature");
  // ALB carries `exp` in the header too, but its payload has it as well; the payload is checked.
  checkClaims(claims, rules);
  return { header, claims };
}

function checkClaims(claims: Claims, rules: VerifyRules): void {
  if (rules.issuer !== undefined && claims.iss !== rules.issuer)
    throw new AuthError("issuer mismatch");
  if (rules.audience !== undefined) {
    const name = rules.audienceClaim ?? "aud";
    if (!claimContains(claims[name], rules.audience))
      throw new AuthError("audience mismatch");
  }
  if (rules.tokenUse) {
    if (claims[rules.tokenUse.claim] !== rules.tokenUse.value)
      throw new AuthError("token use mismatch");
  }
  const now = rules.now();
  const exp = numericDate(claims, "exp");
  if (exp === undefined) throw new AuthError("missing exp");
  if (now >= exp + CLOCK_SKEW_SEC) throw new AuthError("expired");
  const nbf = numericDate(claims, "nbf");
  if (nbf !== undefined && nbf - CLOCK_SKEW_SEC > now)
    throw new AuthError("not yet valid");
  const iat = numericDate(claims, "iat");
  if (iat !== undefined && iat - CLOCK_SKEW_SEC > now)
    throw new AuthError("issued in the future");
  const maxLifetime = rules.maxLifetimeSec ?? DEFAULT_MAX_LIFETIME_SEC;
  // Measured from `iat` when present; otherwise the remaining life is bounded instead.
  const lifetime = iat !== undefined ? exp - iat : exp - now;
  if (lifetime > maxLifetime + CLOCK_SKEW_SEC)
    throw new AuthError("lifetime too long");
  if (iat !== undefined && now - iat > maxLifetime + CLOCK_SKEW_SEC)
    throw new AuthError("token too old");
}

/* ------------------------------------------------------------------ key sources */

/** Max-age from Cache-Control clamped to [5 min, 24 h]; absent means one hour. */
export function cacheTtlSec(cacheControl: string | null): number {
  const match = cacheControl && /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl);
  const ttl = match?.[1] ? Number(match[1]) : DEFAULT_KEY_TTL_SEC;
  return Math.min(MAX_KEY_TTL_SEC, Math.max(MIN_KEY_TTL_SEC, ttl));
}

export interface KeySourceOptions {
  fetch?: FetchLike;
  /** Seconds since the epoch. */
  now?: () => number;
  /** Class-only failure logging. */
  onFetchFailure?: (cls: string) => void;
  minRefetchIntervalSec?: number;
}
const nowSec = () => Math.floor(Date.now() / 1000);

async function fetchBounded(
  fetchFn: FetchLike,
  url: string,
): Promise<{ text: string; cacheControl: string | null }> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json, application/x-pem-file, */*" },
    });
  } catch {
    throw new AuthError("key fetch failed", "unavailable");
  }
  if (!response.ok) throw new AuthError("key fetch status", "unavailable");
  const text = await response.text();
  if (text.length > MAX_FETCH_BYTES)
    throw new AuthError("key response too large", "unavailable");
  return { text, cacheControl: response.headers.get("cache-control") };
}

interface JwkLike {
  kty?: unknown;
  kid?: unknown;
  alg?: unknown;
  use?: unknown;
  crv?: unknown;
  n?: unknown;
  e?: unknown;
  x?: unknown;
  y?: unknown;
  key_ops?: unknown;
}
export interface Jwks {
  keys: JwkLike[];
}
export function parseJwks(value: unknown): Jwks {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as Jwks).keys)
  )
    throw new AuthError("invalid JWKS");
  return {
    keys: (value as Jwks).keys.filter(
      (k): k is JwkLike => !!k && typeof k === "object",
    ),
  };
}

async function importJwk(jwk: JwkLike, alg: JwtAlgorithm): Promise<CryptoKey> {
  const rsa = alg === "RS256" || alg === "PS256";
  if (rsa) {
    if (
      jwk.kty !== "RSA" ||
      typeof jwk.n !== "string" ||
      typeof jwk.e !== "string"
    )
      throw new AuthError("key type mismatch");
    // 2048 bits is 256 bytes, about 342 base64url characters.
    if (decodeBase64(jwk.n).length < 256)
      throw new AuthError("RSA key too short");
    return crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      importParams(alg),
      false,
      ["verify"],
    );
  }
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string"
  )
    throw new AuthError("key type mismatch");
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    importParams(alg),
    false,
    ["verify"],
  );
}

/** A JWK is usable for `alg` only when its own `alg` / `use` / `key_ops` do not say otherwise. */
function jwkAllows(jwk: JwkLike, alg: JwtAlgorithm): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify"))
    return false;
  const rsa = alg === "RS256" || alg === "PS256";
  return rsa ? jwk.kty === "RSA" : jwk.kty === "EC" && jwk.crv === "P-256";
}

function selectJwk(
  jwks: Jwks,
  header: JwtHeader,
  alg: JwtAlgorithm,
): JwkLike | "unknown" {
  if (header.kid === undefined) {
    if (jwks.keys.length !== 1) throw new AuthError("kid required");
    const only = jwks.keys[0] as JwkLike;
    if (!jwkAllows(only, alg)) throw new AuthError("key not usable for alg");
    return only;
  }
  const candidates = jwks.keys.filter((k) => k.kid === header.kid);
  if (candidates.length === 0) return "unknown";
  if (candidates.length > 1) throw new AuthError("ambiguous kid");
  const jwk = candidates[0] as JwkLike;
  if (!jwkAllows(jwk, alg)) throw new AuthError("key not usable for alg");
  return jwk;
}

export interface JwksSourceOptions extends KeySourceOptions {
  /** Inline key set: never refetched. */
  jwks?: unknown;
  /** Key set URL; with `issuer` and no URL, taken from OpenID discovery. */
  jwksUri?: string;
  issuer?: string;
}

/** JWKS from config or from a URL (explicit or discovered), cached per instance. */
export class JwksKeySource implements KeySource {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly minInterval: number;
  private jwks: Jwks | undefined;
  private expiresAt = 0;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;
  private readonly imported = new Map<string, CryptoKey>();
  private readonly inline: boolean;
  constructor(private readonly options: JwksSourceOptions) {
    this.fetchFn = options.fetch ?? ((u, i) => fetch(u, i));
    this.now = options.now ?? nowSec;
    this.minInterval =
      options.minRefetchIntervalSec ?? MIN_REFETCH_INTERVAL_SEC;
    this.inline = options.jwks !== undefined;
    if (this.inline) this.jwks = parseJwks(options.jwks);
    else if (!options.jwksUri && !options.issuer)
      throw new Error("A JWKS needs inline keys, a jwksUri or an issuer");
  }
  private async discover(): Promise<string> {
    const issuer = this.options.issuer as string;
    const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const { text } = await fetchBounded(this.fetchFn, url);
    let doc: { issuer?: unknown; jwks_uri?: unknown };
    try {
      doc = JSON.parse(text);
    } catch {
      throw new AuthError("invalid discovery document", "unavailable");
    }
    if (doc.issuer !== issuer)
      throw new AuthError("discovery issuer mismatch", "unavailable");
    if (typeof doc.jwks_uri !== "string" || !isFetchableUrl(doc.jwks_uri))
      throw new AuthError("invalid jwks_uri", "unavailable");
    return doc.jwks_uri;
  }
  private async refresh(): Promise<void> {
    this.lastAttempt = this.now();
    try {
      // Discovery is repeated with every refresh so a moved jwks_uri is followed.
      const uri = this.options.jwksUri ?? (await this.discover());
      const { text, cacheControl } = await fetchBounded(this.fetchFn, uri);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AuthError("invalid JWKS", "unavailable");
      }
      this.jwks = parseJwks(parsed);
      this.imported.clear();
      this.expiresAt = this.now() + cacheTtlSec(cacheControl);
    } catch (error) {
      this.options.onFetchFailure?.(
        error instanceof AuthError ? error.reason : "error",
      );
      if (error instanceof AuthError && error.kind === "unavailable")
        throw error;
      throw new AuthError("key fetch failed", "unavailable");
    }
  }
  private refreshOnce(): Promise<void> {
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
  /** Fetch is allowed when not recently attempted; the rate limit holds for failures too. */
  private canFetch(): boolean {
    return this.now() - this.lastAttempt >= this.minInterval;
  }
  async getKey(header: JwtHeader, alg: JwtAlgorithm): Promise<CryptoKey> {
    if (!this.inline && (!this.jwks || this.now() >= this.expiresAt)) {
      if (this.inflight) await this.inflight;
      else if (!this.jwks || this.canFetch()) {
        if (!this.canFetch())
          throw new AuthError("key refetch rate limited", "unavailable");
        await this.refreshOnce();
      } else {
        // Expired cache and a recent failed attempt: fail closed rather than trust stale keys.
        throw new AuthError("keys expired", "unavailable");
      }
    }
    let selected = selectJwk(this.jwks as Jwks, header, alg);
    if (selected === "unknown") {
      // At most one refetch per token, and at most one per interval per instance.
      if (this.inline || !this.canFetch()) throw new AuthError("unknown kid");
      await this.refreshOnce();
      selected = selectJwk(this.jwks as Jwks, header, alg);
      if (selected === "unknown") throw new AuthError("unknown kid");
    }
    const id = `${alg}:${header.kid ?? ""}`;
    let key = this.imported.get(id);
    if (!key) {
      key = await importJwk(selected, alg);
      this.imported.set(id, key);
    }
    return key;
  }
}
function isFetchableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || isLoopbackHttp(url);
  } catch {
    return false;
  }
}
/** Plain HTTP is accepted for loopback hosts only (local development and tests). */
export function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

export interface PemKidSourceOptions extends KeySourceOptions {
  /** URL with a `{kid}` placeholder; the kid is validated before substitution. */
  urlTemplate: string;
}
const KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PEM_PATTERN =
  /^-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*$/;

/** Per-`kid` PEM (SPKI) key endpoint, as AWS ALB publishes; same caching and rate limits. */
export class PemKidKeySource implements KeySource {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly minInterval: number;
  private readonly cache = new Map<
    string,
    { key: CryptoKey; expiresAt: number }
  >();
  private lastAttempt = Number.NEGATIVE_INFINITY;
  constructor(private readonly options: PemKidSourceOptions) {
    if (!options.urlTemplate.includes("{kid}"))
      throw new Error("urlTemplate needs a {kid} placeholder");
    this.fetchFn = options.fetch ?? ((u, i) => fetch(u, i));
    this.now = options.now ?? nowSec;
    this.minInterval =
      options.minRefetchIntervalSec ?? MIN_REFETCH_INTERVAL_SEC;
  }
  async getKey(header: JwtHeader, alg: JwtAlgorithm): Promise<CryptoKey> {
    if (alg !== "ES256") throw new AuthError("PEM source is ES256 only");
    const kid = header.kid;
    if (typeof kid !== "string" || !KID_PATTERN.test(kid))
      throw new AuthError("invalid kid");
    const hit = this.cache.get(kid);
    if (hit && this.now() < hit.expiresAt) return hit.key;
    // One fetch per interval per instance, whichever kid asks, so forged kids cannot amplify.
    if (this.now() - this.lastAttempt < this.minInterval)
      throw new AuthError("key refetch rate limited", "unavailable");
    this.lastAttempt = this.now();
    try {
      const { text, cacheControl } = await fetchBounded(
        this.fetchFn,
        this.options.urlTemplate.replace("{kid}", encodeURIComponent(kid)),
      );
      const match = PEM_PATTERN.exec(text.trim());
      if (!match?.[1]) throw new AuthError("invalid PEM", "unavailable");
      const der = decodeBase64(match[1].replace(/\s+/g, ""), true);
      const key = await crypto.subtle.importKey(
        "spki",
        der as BufferSource,
        importParams("ES256"),
        false,
        ["verify"],
      );
      this.cache.set(kid, {
        key,
        expiresAt: this.now() + cacheTtlSec(cacheControl),
      });
      if (this.cache.size > 32) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      return key;
    } catch (error) {
      this.options.onFetchFailure?.(
        error instanceof AuthError ? error.reason : "error",
      );
      throw error instanceof AuthError
        ? error
        : new AuthError("key import failed", "unavailable");
    }
  }
}
