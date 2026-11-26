import type {
  HeaderMapping,
  SignedProxySettings,
  UnsignedProxySettings,
} from "@moriyoshi/errtraq-core/runtime";
import {
  AuthError,
  type Claims,
  decodeBase64,
  type JwtAlgorithm,
  type VerifyRules,
} from "./jwt.js";

/**
 * Preset defaults, each checked against the vendor documentation (see JOURNAL.md, UI-e):
 * - Google IAP: https://docs.cloud.google.com/iap/docs/signed-headers-howto
 * - Cloudflare Access: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 * - AWS ALB: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html
 * - Pomerium: https://www.pomerium.com/docs/capabilities/getting-users-identity
 */
export interface ResolvedSignedProxy {
  header: string;
  rules: Omit<VerifyRules, "now">;
  keys:
    | { type: "jwks"; jwks?: unknown; jwksUri?: string; issuer?: string }
    | { type: "pem"; urlTemplate: string };
  assumeEmailVerified: boolean;
}

function albRegion(signer: string): string | undefined {
  // arn:aws:elasticloadbalancing:<region>:<account>:loadbalancer/app/<name>/<id>
  const match =
    /^arn:aws:elasticloadbalancing:([a-z0-9-]+):\d{12}:loadbalancer\//.exec(
      signer,
    );
  return match?.[1];
}

/** Merge a preset's defaults under the explicit settings; every field stays overridable. */
export function resolveSignedProxy(
  s: SignedProxySettings,
): ResolvedSignedProxy {
  const preset = s.preset ?? "generic";
  let header: string | undefined = s.header;
  let issuer = s.issuer;
  let jwksUri = s.jwksUri;
  let algorithms: JwtAlgorithm[] | undefined = s.algorithms;
  let maxLifetimeSec = s.maxLifetimeSec;
  let assume = s.assumeEmailVerified;
  let lenientBase64 = false;
  let headerExpFallback = false;
  let keyUrl = s.keyUrl;
  switch (preset) {
    case "google-iap":
      header ??= "x-goog-iap-jwt-assertion";
      issuer ??= "https://cloud.google.com/iap";
      if (!s.jwks)
        jwksUri ??= "https://www.gstatic.com/iap/verify/public_key-jwk";
      algorithms ??= ["ES256"];
      // The documented maximum lifetime is 10 minutes plus twice a 30 s skew.
      maxLifetimeSec ??= 660;
      assume ??= true;
      break;
    case "cloudflare-access":
      header ??= "cf-access-jwt-assertion";
      issuer ??= `https://${s.team}.cloudflareaccess.com`;
      if (!s.jwks) jwksUri ??= `${issuer}/cdn-cgi/access/certs`;
      algorithms ??= ["RS256"];
      assume ??= true;
      break;
    case "aws-alb": {
      header ??= "x-amzn-oidc-data";
      algorithms ??= ["ES256"];
      // The ALB token is short-lived and standard-base64 padded; its `exp` is documented in
      // the JWT header.
      maxLifetimeSec ??= 600;
      lenientBase64 = true;
      headerExpFallback = true;
      const region = s.signer ? albRegion(s.signer) : undefined;
      if (!keyUrl) {
        if (!region)
          throw new Error(
            "aws-alb: keyUrl is required when the signer ARN is not a commercial-region ALB ARN",
          );
        keyUrl = `https://public-keys.auth.elb.${region}.amazonaws.com/{kid}`;
      }
      break;
    }
    case "pomerium":
      header ??= "x-pomerium-jwt-assertion";
      // The documentation names no algorithm; accept both curve and RSA signatures.
      algorithms ??= ["ES256", "RS256"];
      // The documented `iss` and `aud` both match the service domain.
      issuer ??= s.audience;
      if (!s.jwks)
        jwksUri ??= `https://${s.audience}/.well-known/pomerium/jwks.json`;
      assume ??= true;
      break;
    case "generic":
      break;
  }
  if (!header) throw new Error("proxy: no assertion header");
  const rules: ResolvedSignedProxy["rules"] = {
    algorithms: algorithms ?? ["RS256", "ES256"],
    ...(issuer && preset !== "aws-alb" ? { issuer } : {}),
    ...(s.audience && preset !== "aws-alb" ? { audience: s.audience } : {}),
    ...(s.signer ? { signer: s.signer } : {}),
    ...(s.tokenUse ? { tokenUse: s.tokenUse } : {}),
    ...(s.typ ? { typ: s.typ } : {}),
    ...(maxLifetimeSec ? { maxLifetimeSec } : {}),
    ...(lenientBase64 ? { lenientBase64 } : {}),
    ...(headerExpFallback ? { headerExpFallback } : {}),
  };
  // ALB assertions carry the IdP's `iss` and no `aud`: only an explicit issuer is checked.
  if (preset === "aws-alb" && s.issuer) rules.issuer = s.issuer;
  const keys: ResolvedSignedProxy["keys"] = keyUrl
    ? { type: "pem", urlTemplate: keyUrl }
    : {
        type: "jwks",
        ...(s.jwks ? { jwks: s.jwks } : {}),
        ...(jwksUri ? { jwksUri } : {}),
        ...(issuer ? { issuer } : {}),
      };
  return { header, rules, keys, assumeEmailVerified: assume === true };
}

/* ------------------------------------------------------------ unsigned headers */

const MAX_HEADER_BYTES = 8192;
const MAX_PRINCIPAL_BYTES = 16384;
const MAX_LIST_ITEMS = 100;
const MAX_ITEM_LENGTH = 256;

/** Constant-time comparison: both sides are hashed first so lengths do not leak either. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 1);
  return diff === 0;
}

/** Split on commas, trim, drop empties, cap the count and the length of every item. */
export function splitList(value: string): string[] {
  const items: string[] = [];
  for (const part of value.split(",")) {
    const item = part.trim();
    if (!item) continue;
    items.push(item.slice(0, MAX_ITEM_LENGTH));
    if (items.length >= MAX_LIST_ITEMS) break;
  }
  return items;
}

const OAUTH2_PROXY_MAPPING: HeaderMapping[] = [
  { header: "x-forwarded-user", claim: "sub" },
  { header: "x-forwarded-email", claim: "email" },
  { header: "x-forwarded-groups", claim: "groups", list: true },
  { header: "x-forwarded-preferred-username", claim: "preferred_username" },
];
const AZURE_MAPPING: HeaderMapping[] = [
  { header: "x-ms-client-principal-id", claim: "sub" },
  { header: "x-ms-client-principal-name", claim: "name" },
];
export const AZURE_PRINCIPAL_HEADER = "x-ms-client-principal";

export function unsignedMapping(s: UnsignedProxySettings): HeaderMapping[] {
  const base =
    s.preset === "oauth2-proxy"
      ? OAUTH2_PROXY_MAPPING
      : s.preset === "azure-app-service"
        ? AZURE_MAPPING
        : [];
  return [...base, ...(s.mapping ?? [])];
}
/** Every header that may carry identity for this source; any of them makes the request ours. */
export function unsignedIdentityHeaders(s: UnsignedProxySettings): string[] {
  return [
    s.secretHeader,
    ...unsignedMapping(s).map((m) => m.header),
    ...(s.preset === "azure-app-service" ? [AZURE_PRINCIPAL_HEADER] : []),
  ];
}

function addClaim(claims: Claims, name: string, value: string): void {
  const current = claims[name];
  if (current === undefined) claims[name] = value;
  else if (Array.isArray(current)) {
    if (current.length < MAX_LIST_ITEMS) current.push(value);
  } else claims[name] = [current, value];
}

/** Build claims from forwarded headers; callers have already checked the shared secret. */
export function unsignedClaims(
  s: UnsignedProxySettings,
  headers: Headers,
): Claims {
  const claims: Claims = {};
  if (s.preset === "azure-app-service") {
    const raw = headers.get(AZURE_PRINCIPAL_HEADER);
    if (raw) {
      if (raw.length > MAX_PRINCIPAL_BYTES)
        throw new AuthError("principal too large");
      let principal: unknown;
      try {
        principal = JSON.parse(
          new TextDecoder().decode(decodeBase64(raw, true)),
        );
      } catch {
        throw new AuthError("malformed principal");
      }
      const list = (principal as { claims?: unknown })?.claims;
      if (!Array.isArray(list)) throw new AuthError("malformed principal");
      const roleTyp = (principal as { role_typ?: unknown }).role_typ;
      for (const claim of list.slice(0, 200)) {
        const typ = (claim as { typ?: unknown })?.typ;
        const val = (claim as { val?: unknown })?.val;
        if (typeof typ !== "string" || typeof val !== "string") continue;
        const v = val.slice(0, MAX_ITEM_LENGTH);
        addClaim(claims, typ, v);
        // `role_typ` names the claim type that carries roles; expose them as `roles` too.
        if (typeof roleTyp === "string" && typ === roleTyp && typ !== "roles")
          addClaim(claims, "roles", v);
      }
    }
  }
  for (const map of unsignedMapping(s)) {
    const raw = headers.get(map.header);
    if (raw === null) continue;
    if (raw.length > MAX_HEADER_BYTES) throw new AuthError("header too large");
    if (map.list) {
      const items = splitList(raw);
      if (items.length) claims[map.claim] = items;
    } else if (raw.trim())
      claims[map.claim] = raw.trim().slice(0, MAX_ITEM_LENGTH);
  }
  if (s.emailVerified === true && typeof claims.email === "string")
    claims.email_verified = true;
  return claims;
}
