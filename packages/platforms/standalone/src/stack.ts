import {
  configReference,
  type InfraDescriptor,
  type PlatformManifest,
  type PlatformSelection,
} from "@errtraq/core";
import { z } from "zod";

const baseConfigSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8787),
  tokenDirectory: z.string().min(1).default(".errtraq"),
  rateLimit: z.number().int().positive().nullable().default(60),
  rateWindowSec: z.number().int().positive().default(60),
  roles: z
    .array(z.enum(["ingest", "api", "consumer", "cron"]))
    .default(["ingest", "api", "consumer", "cron"]),
  split: z
    .array(z.enum(["ingest", "api", "consumer", "cron"]))
    .max(0)
    .default([]),
  http: z.array(z.enum(["ingest", "api"])).default(["ingest", "api"]),
  settings: z
    .partialRecord(
      z.enum(["ingest", "api", "consumer", "cron"]),
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
  .refine(
    (config) => config.roles.length === 4 && new Set(config.roles).size === 4,
    { message: "Standalone deploys all roles in one process" },
  )
  .refine(
    (config) => !config.settings || Object.keys(config.settings).length === 0,
    { message: "Standalone does not support function resource settings" },
  );
export type StandaloneConfig = z.input<typeof configSchema>;
const stackConfigSchema = baseConfigSchema
  .extend({
    port: portWithReference,
    tokenDirectory: configReference(z.string().min(1)).default(".errtraq"),
  })
  .refine(
    (config) => config.roles.length === 4 && new Set(config.roles).size === 4,
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
    runtimeModule: "@errtraq/platform-standalone",
    config,
  };
}
