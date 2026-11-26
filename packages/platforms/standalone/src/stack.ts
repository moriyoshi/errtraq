import {
  type AuthSettingsInput,
  authSettingsProblem,
  configReference,
  type InfraDescriptor,
  type PlatformManifest,
  type PlatformSelection,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";

const publicUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Public URL must be an HTTP(S) origin without credentials");
/** An exact CORS origin: scheme, host and optional port, no path; never a wildcard. */
export const corsOrigins = z
  .array(
    z.string().refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) && url.origin === value
        );
      } catch {
        return false;
      }
    }, "CORS origin must be an exact HTTP(S) origin without a path"),
  )
  .min(1)
  .max(20);
const isObject = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const baseConfigSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  publicUrl: publicUrl.optional(),
  port: z.number().int().min(0).max(65535).default(8787),
  tokenDirectory: z.string().min(1).default(".errtraq"),
  /**
   * Origins allowed to call the API from a browser (a UI served from another origin). Absent
   * means no CORS headers; the UI this process serves itself (`uiDirectory`) is same origin.
   */
  apiCorsOrigins: corsOrigins.optional(),
  /**
   * Directory of built web UI assets (`packages/ui/dist`) served at `/` by this server. Relative
   * paths resolve against the working directory, like `tokenDirectory`.
   */
  uiDirectory: z.string().min(1).optional(),
  /**
   * OIDC Bearer JWT sign-in (claims map to an organization and scopes through `grants`). Off
   * unless set. See `OidcSettings` in `@moriyoshi/errtraq-http`.
   */
  oidc: z.custom<AuthSettingsInput["oidc"]>(isObject).optional(),
  /**
   * Identity asserted by a proxy in front of this server: a signed assertion header (preset for
   * Google IAP, Cloudflare Access, AWS ALB, Pomerium) or, behind a verified shared secret,
   * plain identity headers. Off unless set.
   */
  proxyAuth: z.custom<AuthSettingsInput["proxy"]>(isObject).optional(),
  rateLimit: z.number().int().positive().nullable().default(60),
  rateWindowSec: z.number().int().positive().default(60),
  roles: z
    .array(z.enum(["ingest", "api", "consumer", "record", "cron"]))
    .default(["ingest", "api", "consumer", "cron"]),
  split: z
    .array(z.enum(["ingest", "api", "consumer", "record", "cron"]))
    .max(0)
    .default([]),
  http: z.array(z.enum(["ingest", "api"])).default(["ingest", "api"]),
  /**
   * Run a cron job every N seconds instead of on its UTC schedule (the schedules are hourly, which
   * is too slow for local archive runs and tests). Only the archive jobs are overridable.
   */
  cronIntervalSec: z
    .partialRecord(
      z.enum(["archive-planner", "retention"]),
      z.number().int().positive(),
    )
    .optional(),
  /**
   * Bound on the total life of an archived event in days (counted from receivedAt); each project's
   * `retentionDays` is the hot-tier age and must be smaller. Absent keeps archived events forever.
   */
  archiveRetentionDays: z.number().int().positive().optional(),
  settings: z
    .partialRecord(
      z.enum(["ingest", "api", "consumer", "record", "cron"]),
      z.strictObject({
        memoryMb: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        architecture: z.enum(["x86_64", "arm64"]).optional(),
      }),
    )
    .optional(),
});
const portWithReference = configReference(
  z.number().int().min(0).max(65535),
).default(8787);
export const configSchema = baseConfigSchema
  .superRefine((config, ctx) => {
    const problem = authSettingsProblem(config, { resolved: true });
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .refine(
    (config) =>
      config.roles.length >= 4 &&
      new Set(config.roles).size === config.roles.length &&
      ["ingest", "api", "consumer", "cron"].every((role) =>
        config.roles.includes(role as "ingest" | "api" | "consumer" | "cron"),
      ),
    { message: "Standalone deploys all roles in one process" },
  )
  .refine(
    (config) => !config.settings || Object.keys(config.settings).length === 0,
    { message: "Standalone does not support function resource settings" },
  );
export type StandaloneConfig = z.input<typeof configSchema>;
const stackConfigSchema = baseConfigSchema
  .extend({
    host: configReference(z.string().min(1)).default("127.0.0.1"),
    publicUrl: configReference(publicUrl).optional(),
    port: portWithReference,
    tokenDirectory: configReference(z.string().min(1)).default(".errtraq"),
    apiCorsOrigins: configReference(corsOrigins).optional(),
    uiDirectory: configReference(z.string().min(1)).optional(),
  })
  .superRefine((config, ctx) => {
    const problem = authSettingsProblem(config);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .refine(
    (config) =>
      config.roles.length >= 4 &&
      new Set(config.roles).size === config.roles.length &&
      ["ingest", "api", "consumer", "cron"].every((role) =>
        config.roles.includes(role as "ingest" | "api" | "consumer" | "cron"),
      ),
    { message: "Standalone deploys all roles in one process" },
  )
  .refine(
    (config) => !config.settings || Object.keys(config.settings).length === 0,
    { message: "Standalone does not support function resource settings" },
  );
type StandaloneStackConfig = z.input<typeof stackConfigSchema>;
export const manifest: PlatformManifest = {
  id: "standalone",
  kind: "platform",
  runtime: "node",
  compute: "long-lived",
  provides: [
    "writable-filesystem",
    "long-lived-process",
    "shared-process-state",
  ],
  authorization: "none",
  bindingKinds: ["env", "secret"],
  configReferenceKinds: ["env", "variable"],
  reservedBindings: [],
  configSchema: stackConfigSchema,
  capabilities: {},
  runtimes: ["node"],
  requires: [],
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<StandaloneStackConfig> = {
  module: { provider: "local", component: "standalone", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {},
  resources: {},
};
export function standalone(
  config: StandaloneStackConfig = {},
): PlatformSelection {
  return {
    manifest,
    infra,
    runtimeModule: "@moriyoshi/errtraq-platform-standalone",
    config,
  };
}
