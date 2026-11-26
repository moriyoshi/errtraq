import type { EnvRef, VariableRef } from "./stack-model.js";
import { isEnvRef, isVariableRef } from "./stack-model.js";

/** Algorithms the JWT verifier in `http` implements. */
export const JWT_ALGORITHMS = ["RS256", "ES256", "PS256"] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];
const MAX_LIFETIME_SEC = 30 * 24 * 3600;
/** Plain HTTP is accepted for loopback hosts only (local development and tests). */
function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

/** Scopes the API actually checks. Grants naming anything else are rejected. */
export const API_SCOPES = ["event:read", "event:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** A value that may be a config reference where the stack file is written. */
export type Refable<T> = T extends string
  ? T | EnvRef | VariableRef
  : T extends readonly (infer U)[]
    ? Refable<U>[]
    : T extends object
      ? { [K in keyof T]: Refable<T[K]> }
      : T;

export interface GrantSetting {
  /** Top-level claim name: `groups`, `cognito:groups`, `roles`, `email`, `hd`, ... */
  claim: string;
  /** Matches when the claim equals it or is an array containing it. No wildcards. */
  value: string;
  /** Organization slug, resolved at request time. */
  org: string;
  scopes: ApiScope[];
}
export interface TokenUseSetting {
  claim: string;
  value: string;
}
/** Bearer JWT from the SPA or any client (Authorization Code + PKCE happens in the browser). */
export interface OidcSettings {
  /** Exact `iss`; HTTPS (plain HTTP only for loopback). */
  issuer: string;
  /** Required value of the audience claim. */
  audience: string;
  /** Claim holding it; `aud` by default (Cognito access tokens: `client_id`). */
  audienceClaim?: string;
  /** Explicit key set URL; absent means OpenID discovery from the issuer. */
  jwksUri?: string;
  /** Inline key set, for functions without egress to the IdP. */
  jwks?: { keys: Record<string, unknown>[] };
  algorithms?: JwtAlgorithm[];
  /** Insist on a token kind, e.g. `{ claim: "token_use", value: "access" }`. */
  tokenUse?: TokenUseSetting;
  /** Accepted `typ` header values, e.g. `["at+jwt"]`. */
  typ?: string[];
  maxLifetimeSec?: number;
  grants: GrantSetting[];
}
export const SIGNED_PROXY_PRESETS = [
  "google-iap",
  "cloudflare-access",
  "aws-alb",
  "pomerium",
  "generic",
] as const;
export type SignedProxyPreset = (typeof SIGNED_PROXY_PRESETS)[number];
/** Identity asserted by a proxy as a signed JWT in a named header. */
export interface SignedProxySettings {
  kind: "signed";
  preset?: SignedProxyPreset;
  header?: string;
  issuer?: string;
  audience?: string;
  /** AWS ALB ARN the `signer` header field must equal. */
  signer?: string;
  /** Cloudflare Access team name (`<team>.cloudflareaccess.com`). */
  team?: string;
  jwksUri?: string;
  jwks?: { keys: Record<string, unknown>[] };
  /** Per-`kid` PEM endpoint with a `{kid}` placeholder (AWS ALB). */
  keyUrl?: string;
  algorithms?: JwtAlgorithm[];
  tokenUse?: TokenUseSetting;
  typ?: string[];
  maxLifetimeSec?: number;
  /** Treat the proxy-asserted `email` as verified (the proxy only asserts verified accounts). */
  assumeEmailVerified?: boolean;
  grants: GrantSetting[];
}
export interface HeaderMapping {
  header: string;
  claim: string;
  /** Comma separated list (groups). */
  list?: boolean;
}
export const UNSIGNED_PROXY_PRESETS = [
  "oauth2-proxy",
  "azure-app-service",
  "custom",
] as const;
export type UnsignedProxyPreset = (typeof UNSIGNED_PROXY_PRESETS)[number];
/**
 * Plain identity headers. Forgeable by anyone who reaches the origin, so they need
 * `trustUnsignedHeaders: true` and a shared secret header the proxy injects.
 */
export interface UnsignedProxySettings {
  kind: "unsigned";
  trustUnsignedHeaders: true;
  preset?: UnsignedProxyPreset;
  /** Header the proxy sets to the shared secret on every request. */
  secretHeader: string;
  /** The secret itself; a config reference in the stack file, never a literal. */
  secret: string;
  mapping?: HeaderMapping[];
  /** Treat `email` as verified. */
  emailVerified?: boolean;
  grants: GrantSetting[];
}
export type ProxySettings = SignedProxySettings | UnsignedProxySettings;
export interface AuthSettings {
  oidc?: OidcSettings;
  proxy?: ProxySettings;
}
export type AuthSettingsInput = Refable<AuthSettings>;

const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_GRANTS = 50;
const MIN_SECRET_LENGTH = 16;
/** Stands in for a config reference while validating a stack file. */
export const REFERENCE_PLACEHOLDER = "https://reference.invalid";

function fail(message: string): never {
  throw new Error(message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  at: string,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${at}: unknown setting ${key}`);
}
function str(value: unknown, at: string, max = 2048): string {
  if (typeof value !== "string" || !value || value.length > max)
    fail(`${at} must be a non-empty string`);
  return value;
}
function optionalStr(value: unknown, at: string): string | undefined {
  return value === undefined ? undefined : str(value, at);
}
/** Exact issuer / URL: HTTPS, or HTTP on a loopback host, no credentials, query or fragment. */
export function checkHttpsUrl(
  value: string,
  at: string,
  keepPath = true,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${at} must be a URL`);
  }
  if (url.protocol !== "https:" && !isLoopbackHttp(url))
    fail(`${at} must be an HTTPS URL`);
  if (url.username || url.password || url.hash || value.endsWith("#"))
    fail(`${at} must not carry credentials or a fragment`);
  if (!keepPath && url.pathname !== "/") fail(`${at} must not have a path`);
}
function checkIssuer(value: string, at: string): void {
  checkHttpsUrl(value, at);
  // `iss` is matched exactly, so an issuer that does not round-trip would never match.
  if (new URL(value).search) fail(`${at} must not carry a query`);
  if (value.includes("*")) fail(`${at} must not contain a wildcard`);
}
function algorithms(value: unknown, at: string): JwtAlgorithm[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((a) => (JWT_ALGORITHMS as readonly unknown[]).includes(a))
  )
    fail(`${at} must be a non-empty list of ${JWT_ALGORITHMS.join(", ")}`);
  return value as JwtAlgorithm[];
}
function tokenUse(value: unknown, at: string): TokenUseSetting | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail(`${at} must be an object`);
  exactKeys(value, ["claim", "value"], at);
  return {
    claim: str(value.claim, `${at}.claim`, 100),
    value: str(value.value, `${at}.value`, 100),
  };
}
function typList(value: unknown, at: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((t) => typeof t === "string" && t)
  )
    fail(`${at} must be a non-empty list of strings`);
  return value as string[];
}
function lifetime(value: unknown, at: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > MAX_LIFETIME_SEC
  )
    fail(
      `${at} must be an integer number of seconds from 60 to ${MAX_LIFETIME_SEC}`,
    );
  return value;
}
function inlineJwks(value: unknown, at: string): OidcSettings["jwks"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    !value.keys.every(isRecord)
  )
    fail(`${at} must be { keys: [...] } with at least one key`);
  return value as OidcSettings["jwks"];
}
function grants(value: unknown, at: string): GrantSetting[] {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${at} must be a non-empty list`);
  if (value.length > MAX_GRANTS)
    fail(`${at} has more than ${MAX_GRANTS} entries`);
  return value.map((raw, i): GrantSetting => {
    const where = `${at}[${i}]`;
    if (!isRecord(raw)) return fail(`${where} must be an object`);
    exactKeys(raw, ["claim", "value", "org", "scopes"], where);
    const claim = str(raw.claim, `${where}.claim`, 100);
    const val = str(raw.value, `${where}.value`, 256);
    if (val.includes("*") || val.includes("?"))
      fail(`${where}.value must not contain wildcards`);
    const org = str(raw.org, `${where}.org`, 100);
    if (!SLUG.test(org)) fail(`${where}.org is not a valid organization slug`);
    if (
      !Array.isArray(raw.scopes) ||
      raw.scopes.length === 0 ||
      !raw.scopes.every((s) => (API_SCOPES as readonly unknown[]).includes(s))
    )
      fail(
        `${where}.scopes must be a non-empty subset of ${API_SCOPES.join(", ")}`,
      );
    return {
      claim,
      value: val,
      org,
      scopes: [...new Set(raw.scopes as ApiScope[])],
    };
  });
}
function headerName(value: unknown, at: string): string {
  const name = str(value, at, 64).toLowerCase();
  if (!HEADER_NAME.test(name)) fail(`${at} is not a valid header name`);
  if (name === "authorization" || name === "cookie")
    fail(`${at} must not be ${name}`);
  return name;
}

export function parseOidcSettings(raw: unknown): OidcSettings {
  if (!isRecord(raw)) return fail("oidc must be an object");
  exactKeys(
    raw,
    [
      "issuer",
      "audience",
      "audienceClaim",
      "jwksUri",
      "jwks",
      "algorithms",
      "tokenUse",
      "typ",
      "maxLifetimeSec",
      "grants",
    ],
    "oidc",
  );
  const issuer = str(raw.issuer, "oidc.issuer");
  checkIssuer(issuer, "oidc.issuer");
  const jwksUri = optionalStr(raw.jwksUri, "oidc.jwksUri");
  if (jwksUri) checkHttpsUrl(jwksUri, "oidc.jwksUri");
  const jwks = inlineJwks(raw.jwks, "oidc.jwks");
  if (jwksUri && jwks) fail("oidc: set jwksUri or jwks, not both");
  const audienceClaim = optionalStr(raw.audienceClaim, "oidc.audienceClaim");
  const algs = algorithms(raw.algorithms, "oidc.algorithms");
  const use = tokenUse(raw.tokenUse, "oidc.tokenUse");
  const typ = typList(raw.typ, "oidc.typ");
  const maxLifetimeSec = lifetime(raw.maxLifetimeSec, "oidc.maxLifetimeSec");
  return {
    issuer,
    audience: str(raw.audience, "oidc.audience", 512),
    ...(audienceClaim ? { audienceClaim } : {}),
    ...(jwksUri ? { jwksUri } : {}),
    ...(jwks ? { jwks } : {}),
    ...(algs ? { algorithms: algs } : {}),
    ...(use ? { tokenUse: use } : {}),
    ...(typ ? { typ } : {}),
    ...(maxLifetimeSec ? { maxLifetimeSec } : {}),
    grants: grants(raw.grants, "oidc.grants"),
  };
}

function parseSignedProxy(raw: Record<string, unknown>): SignedProxySettings {
  exactKeys(
    raw,
    [
      "kind",
      "preset",
      "header",
      "issuer",
      "audience",
      "signer",
      "team",
      "jwksUri",
      "jwks",
      "keyUrl",
      "algorithms",
      "tokenUse",
      "typ",
      "maxLifetimeSec",
      "assumeEmailVerified",
      "grants",
    ],
    "proxy",
  );
  const preset = (raw.preset ?? "generic") as SignedProxyPreset;
  if (!SIGNED_PROXY_PRESETS.includes(preset))
    fail(`proxy.preset must be one of ${SIGNED_PROXY_PRESETS.join(", ")}`);
  const out: SignedProxySettings = {
    kind: "signed",
    preset,
    grants: grants(raw.grants, "proxy.grants"),
  };
  if (raw.header !== undefined)
    out.header = headerName(raw.header, "proxy.header");
  if (raw.issuer !== undefined) {
    out.issuer = str(raw.issuer, "proxy.issuer");
    // Pomerium's issuer is a bare hostname, the others are URLs.
    if (preset !== "pomerium") checkIssuer(out.issuer, "proxy.issuer");
  }
  if (raw.audience !== undefined)
    out.audience = str(raw.audience, "proxy.audience", 512);
  if (raw.signer !== undefined)
    out.signer = str(raw.signer, "proxy.signer", 512);
  if (raw.team !== undefined) {
    out.team = str(raw.team, "proxy.team", 63);
    if (!/^[a-z0-9-]+$/i.test(out.team) && out.team !== REFERENCE_PLACEHOLDER)
      fail("proxy.team must be the Cloudflare team name only");
  }
  if (raw.jwksUri !== undefined) {
    out.jwksUri = str(raw.jwksUri, "proxy.jwksUri");
    checkHttpsUrl(out.jwksUri, "proxy.jwksUri");
  }
  const jwks = inlineJwks(raw.jwks, "proxy.jwks");
  if (jwks) out.jwks = jwks;
  if (out.jwksUri && out.jwks) fail("proxy: set jwksUri or jwks, not both");
  if (raw.keyUrl !== undefined) {
    out.keyUrl = str(raw.keyUrl, "proxy.keyUrl");
    if (!out.keyUrl.includes("{kid}"))
      fail("proxy.keyUrl needs a {kid} placeholder");
    checkHttpsUrl(out.keyUrl.replace("{kid}", "kid"), "proxy.keyUrl");
  }
  const algs = algorithms(raw.algorithms, "proxy.algorithms");
  if (algs) out.algorithms = algs;
  const use = tokenUse(raw.tokenUse, "proxy.tokenUse");
  if (use) out.tokenUse = use;
  const typ = typList(raw.typ, "proxy.typ");
  if (typ) out.typ = typ;
  const life = lifetime(raw.maxLifetimeSec, "proxy.maxLifetimeSec");
  if (life) out.maxLifetimeSec = life;
  if (raw.assumeEmailVerified !== undefined) {
    if (typeof raw.assumeEmailVerified !== "boolean")
      fail("proxy.assumeEmailVerified must be a boolean");
    out.assumeEmailVerified = raw.assumeEmailVerified;
  }
  // Every preset must bind the assertion to this deployment: an audience, or an ALB signer.
  if (!out.audience && !out.signer)
    fail("proxy: audience (or, for aws-alb, signer) is required");
  if (preset === "aws-alb" && !out.signer)
    fail("proxy.signer is required for aws-alb");
  if (preset === "cloudflare-access" && !out.team && !out.issuer)
    fail("proxy.team (or issuer) is required for cloudflare-access");
  if (preset === "generic") {
    if (!out.header) fail("proxy.header is required for the generic preset");
    if (!out.jwks && !out.jwksUri && !out.keyUrl && !out.issuer)
      fail(
        "proxy: the generic preset needs jwks, jwksUri, keyUrl or an issuer",
      );
  }
  if (preset === "pomerium" && !out.jwksUri && !out.jwks && !out.audience)
    fail("proxy: pomerium needs audience (the service domain) or jwksUri");
  return out;
}

function parseUnsignedProxy(
  raw: Record<string, unknown>,
): UnsignedProxySettings {
  exactKeys(
    raw,
    [
      "kind",
      "trustUnsignedHeaders",
      "preset",
      "secretHeader",
      "secret",
      "mapping",
      "emailVerified",
      "grants",
    ],
    "proxy",
  );
  if (raw.trustUnsignedHeaders !== true)
    fail("proxy: unsigned identity headers need trustUnsignedHeaders: true");
  const preset = (raw.preset ?? "custom") as UnsignedProxyPreset;
  if (!UNSIGNED_PROXY_PRESETS.includes(preset))
    fail(`proxy.preset must be one of ${UNSIGNED_PROXY_PRESETS.join(", ")}`);
  const secret = str(raw.secret, "proxy.secret", 512);
  if (secret.length < MIN_SECRET_LENGTH)
    fail(`proxy.secret must be at least ${MIN_SECRET_LENGTH} characters`);
  const out: UnsignedProxySettings = {
    kind: "unsigned",
    trustUnsignedHeaders: true,
    preset,
    secretHeader: headerName(raw.secretHeader, "proxy.secretHeader"),
    secret,
    grants: grants(raw.grants, "proxy.grants"),
  };
  if (raw.mapping !== undefined) {
    if (
      !Array.isArray(raw.mapping) ||
      raw.mapping.length === 0 ||
      raw.mapping.length > 20
    )
      fail("proxy.mapping must be a list of 1 to 20 entries");
    out.mapping = raw.mapping.map((m, i): HeaderMapping => {
      if (!isRecord(m)) return fail(`proxy.mapping[${i}] must be an object`);
      exactKeys(m, ["header", "claim", "list"], `proxy.mapping[${i}]`);
      return {
        header: headerName(m.header, `proxy.mapping[${i}].header`),
        claim: str(m.claim, `proxy.mapping[${i}].claim`, 100),
        ...(m.list === true ? { list: true } : {}),
      };
    });
  }
  if (preset === "custom" && !out.mapping)
    fail("proxy.mapping is required for the custom preset");
  if (out.mapping?.some((m) => m.header === out.secretHeader))
    fail("proxy.mapping must not map the shared secret header");
  if (raw.emailVerified !== undefined) {
    if (typeof raw.emailVerified !== "boolean")
      fail("proxy.emailVerified must be a boolean");
    out.emailVerified = raw.emailVerified;
  }
  return out;
}

export function parseProxySettings(raw: unknown): ProxySettings {
  if (!isRecord(raw)) return fail("proxy must be an object");
  if (raw.kind === "signed") return parseSignedProxy(raw);
  if (raw.kind === "unsigned") return parseUnsignedProxy(raw);
  return fail('proxy.kind must be "signed" or "unsigned"');
}

/** Validate the whole settings object; throws an Error with a field path and no secret values. */
export function parseAuthSettings(raw: unknown): AuthSettings {
  if (!isRecord(raw)) return fail("auth settings must be an object");
  exactKeys(raw, ["oidc", "proxy"], "auth");
  return {
    ...(raw.oidc === undefined ? {} : { oidc: parseOidcSettings(raw.oidc) }),
    ...(raw.proxy === undefined
      ? {}
      : { proxy: parseProxySettings(raw.proxy) }),
  };
}

/** Replace config references with a placeholder; reports where the proxy secret was a reference. */
export function withoutReferences(raw: unknown): {
  value: unknown;
  secretIsReference: boolean;
} {
  let secretIsReference = false;
  const walk = (v: unknown, path: string): unknown => {
    if (isEnvRef(v) || isVariableRef(v)) {
      if (path === "proxy.secret") secretIsReference = true;
      return REFERENCE_PLACEHOLDER;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`));
    if (isRecord(v))
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          walk(x, path ? `${path}.${k}` : k),
        ]),
      );
    return v;
  };
  const value = walk(raw, "");
  return { value, secretIsReference };
}

/**
 * Stack-time validation shared by the platforms. The unsigned secret must be a config reference.
 * Placeholders are valid URLs, so reference-typed fields validate like their resolved values.
 */
export function validateAuthSettingsInStack(raw: unknown): AuthSettings {
  const { value, secretIsReference } = withoutReferences(raw);
  const parsed = parseAuthSettings(value);
  if (parsed.proxy?.kind === "unsigned" && !secretIsReference)
    fail(
      "proxy.secret must be a config reference (env or variable), not a literal",
    );
  return parsed;
}

/** Message for the first problem in a platform's `oidc` / `proxyAuth` settings, or undefined. */
export function authSettingsProblem(
  config: { oidc?: unknown; proxyAuth?: unknown },
  options: { resolved?: boolean } = {},
): string | undefined {
  const raw = {
    ...(config.oidc === undefined ? {} : { oidc: config.oidc }),
    ...(config.proxyAuth === undefined ? {} : { proxy: config.proxyAuth }),
  };
  try {
    if (options.resolved) parseAuthSettings(raw);
    else validateAuthSettingsInStack(raw);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid sign-in settings";
  }
}

/** The runtime shape of a platform's settings, or undefined when no sign-in is configured. */
export function authSettingsOf(config: {
  oidc?: unknown;
  proxyAuth?: unknown;
}): AuthSettings | undefined {
  if (config.oidc === undefined && config.proxyAuth === undefined)
    return undefined;
  return parseAuthSettings({
    ...(config.oidc === undefined ? {} : { oidc: config.oidc }),
    ...(config.proxyAuth === undefined ? {} : { proxy: config.proxyAuth }),
  });
}
