import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { createServer, type Server } from "node:http";

const b64 = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

export interface FakeIdp {
  issuer: string;
  /** Sign claims with the provider key (the e2e signing proxy uses it for its assertions). */
  sign(claims: Record<string, unknown>): string;
  /** Token requests seen, for assertions. */
  tokenRequests: URLSearchParams[];
  close(): Promise<void>;
}

/**
 * A minimal OpenID provider for the sign-in test (Node only, no dependency): discovery, a JWKS,
 * an authorize endpoint that redirects straight back with a code (no login page), and a token
 * endpoint that checks the PKCE verifier and issues RS256 JWTs.
 */
export async function startFakeIdp(port: number): Promise<FakeIdp> {
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "idp-1",
    use: "sig",
    alg: "RS256",
  };
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const tokenRequests: URLSearchParams[] = [];
  const sign = (claims: Record<string, unknown>) => {
    const head = b64(
      JSON.stringify({ alg: "RS256", kid: "idp-1", typ: "JWT" }),
    );
    const body = b64(JSON.stringify(claims));
    const signature = createSign("RSA-SHA256")
      .update(`${head}.${body}`)
      .sign(privateKey);
    return `${head}.${body}.${b64(signature)}`;
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    res.setHeader("access-control-allow-origin", "*");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const redirect = q.get("redirect_uri");
      if (
        !redirect ||
        q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("code_challenge") ||
        !q.get("state") ||
        !q.get("nonce")
      ) {
        res.writeHead(400);
        return res.end("bad authorization request");
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge: q.get("code_challenge") ?? "",
        nonce: q.get("nonce") ?? "",
      });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.setEncoding("utf8").on("data", (c: string) => {
        raw += c;
      });
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        tokenRequests.push(form);
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        if (!entry || entry.challenge !== challenge)
          return json({ error: "invalid_grant" }, 400);
        const now = Math.floor(Date.now() / 1000);
        const common = {
          iss: issuer,
          sub: "e2e-user",
          iat: now,
          exp: now + 600,
        };
        return json({
          token_type: "Bearer",
          expires_in: 600,
          access_token: sign({
            ...common,
            aud: "errtraq",
            email: "e2e@example.test",
            email_verified: true,
            groups: ["errtraq-admins"],
          }),
          id_token: sign({ ...common, aud: "errtraq-ui", nonce: entry.nonce }),
        });
      });
      return;
    }
    if (url.pathname === "/logout") {
      const back = url.searchParams.get("post_logout_redirect_uri");
      res.writeHead(back ? 302 : 200, back ? { location: back } : {});
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    issuer,
    sign,
    tokenRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
