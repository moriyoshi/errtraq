import { fsBlob } from "@moriyoshi/errtraq-blob-fs/stack";
import { defineStack, env } from "@moriyoshi/errtraq-core";
import { memoryKv } from "@moriyoshi/errtraq-kv-memory/stack";
import { standalone } from "@moriyoshi/errtraq-platform-standalone/stack";
import { memoryQueue } from "@moriyoshi/errtraq-queue-memory/stack";
import { sqlite } from "@moriyoshi/errtraq-store-sql/stack";

/**
 * `stacks/local.ts` plus OIDC Bearer sign-in and a signed proxy assertion, for the UI end-to-end test: its fake identity
 * provider is at `ERRTRAQ_OIDC_ISSUER`. API tokens keep working next to it.
 */
export default defineStack({
  name: "local-oidc",
  providers: {},
  platform: standalone({
    host: env("ERRTRAQ_HOST", { defaultValue: "127.0.0.1" }),
    port: env("ERRTRAQ_PORT", { defaultValue: "8787", valueType: "number" }),
    tokenDirectory: env("ERRTRAQ_DATA_DIR", { defaultValue: ".errtraq" }),
    // The origin DSNs are built from (the API key list shows `dsn` only when this is set).
    publicUrl: env("ERRTRAQ_PUBLIC_URL", {
      defaultValue: "http://127.0.0.1:8787",
    }),
    rateLimit: 10000,
    roles: ["ingest", "api", "consumer", "cron"],
    split: [],
    http: ["ingest", "api"],
    // A signing proxy in front of the server (the e2e test plays one): any header, the same keys.
    proxyAuth: {
      kind: "signed",
      preset: "generic",
      header: "x-e2e-assertion",
      issuer: env("ERRTRAQ_OIDC_ISSUER"),
      audience: "errtraq-proxy",
      jwksUri: env("ERRTRAQ_OIDC_ISSUER", { suffix: "/jwks" }),
      grants: [
        {
          claim: "groups",
          value: "errtraq-admins",
          org: "default",
          scopes: ["event:read", "event:write"],
        },
      ],
    },
    oidc: {
      issuer: env("ERRTRAQ_OIDC_ISSUER"),
      audience: "errtraq",
      grants: [
        {
          claim: "groups",
          value: "errtraq-admins",
          org: "default",
          scopes: ["event:read", "event:write"],
        },
      ],
    },
  }),
  store: sqlite({
    path: env("ERRTRAQ_DATA_DIR", {
      defaultValue: ".errtraq",
      suffix: "/events.sqlite",
    }),
  }),
  queue: memoryQueue(),
  blob: fsBlob({
    root: env("ERRTRAQ_DATA_DIR", {
      defaultValue: ".errtraq",
      suffix: "/blobs",
    }),
  }),
  kv: memoryKv(),
});
