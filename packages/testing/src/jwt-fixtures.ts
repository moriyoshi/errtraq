/** WebCrypto-generated keys and tokens for the authentication tests; no fixtures, no network. */

export type TestAlg = "RS256" | "ES256" | "PS256";
export interface TestKey {
  alg: TestAlg;
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown> & { kid: string };
  publicKey: CryptoKey;
}

const algorithms = {
  RS256: {
    gen: {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    sign: { name: "RSASSA-PKCS1-v1_5" },
  },
  PS256: {
    gen: {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    sign: { name: "RSA-PSS", saltLength: 32 },
  },
  ES256: {
    gen: { name: "ECDSA", namedCurve: "P-256" },
    sign: { name: "ECDSA", hash: "SHA-256" },
  },
} as const;

export async function generateKey(alg: TestAlg, kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    algorithms[alg].gen as RsaHashedKeyGenParams | EcKeyGenParams,
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = {
    ...jwk,
    kid,
    use: "sig",
    alg,
  } as unknown as TestKey["publicJwk"];
  delete (publicJwk as { key_ops?: unknown }).key_ops;
  delete (publicJwk as { ext?: unknown }).ext;
  return {
    alg,
    kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
  };
}

function b64(bytes: Uint8Array, padded: boolean, standard: boolean): string {
  let text = btoa(String.fromCharCode(...bytes));
  if (!standard) text = text.replaceAll("+", "-").replaceAll("/", "_");
  return padded ? text : text.replace(/=+$/, "");
}
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export interface MintOptions {
  header?: Record<string, unknown>;
  /** ALB style: standard base64 with padding. */
  albEncoding?: boolean;
  /** Replace the signature with a corrupted one. */
  tamper?: boolean;
}
export async function mint(
  key: TestKey,
  claims: Record<string, unknown>,
  options: MintOptions = {},
): Promise<string> {
  const header = { alg: key.alg, kid: key.kid, ...options.header };
  const alb = options.albEncoding === true;
  const head = b64(enc(header), alb, alb);
  const body = b64(enc(claims), alb, alb);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      algorithms[key.alg].sign,
      key.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    ),
  );
  if (options.tamper) signature[0] = (signature[0] ?? 0) ^ 0xff;
  return `${head}.${body}.${b64(signature, alb, alb)}`;
}
/** A token signed with `alg: none` or HS256 in the header, to prove they are refused. */
export function unsignedToken(
  alg: string,
  claims: Record<string, unknown>,
): string {
  const head = b64(enc({ alg, typ: "JWT" }), false, false);
  return `${head}.${b64(enc(claims), false, false)}.c2ln`;
}

export async function pemOf(key: TestKey): Promise<string> {
  const der = new Uint8Array(
    await crypto.subtle.exportKey("spki", key.publicKey),
  );
  const body = b64(der, true, true)
    .match(/.{1,64}/g)
    ?.join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

export const NOW = Date.parse("2025-01-01T00:00:00.000Z") / 1000;

/** A `fetch` that serves fixed bodies and counts calls per URL. */
export function fakeFetch(
  routes: Record<
    string,
    () => { body: string; headers?: Record<string, string>; status?: number }
  >,
) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    const { body, headers, status } = route();
    return new Response(body, { status: status ?? 200, headers });
  };
  return { fetch: fetchFn, calls };
}
