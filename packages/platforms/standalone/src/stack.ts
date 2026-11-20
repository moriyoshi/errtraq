import type {
  InfraDescriptor,
  PlatformManifest,
  PlatformSelection,
} from "@errtraq/core";
import { z } from "zod";
export const configSchema = z
  .strictObject({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    rateLimit: z.number().int().positive().nullable().default(60),
    rateWindowSec: z.number().int().positive().default(60),
    roles: z
      .array(z.enum(["ingest", "api", "consumer", "cron"]))
      .default(["ingest", "api", "consumer", "cron"]),
    split: z
      .array(z.enum(["ingest", "api", "consumer", "cron"]))
      .max(0)
      .default([]),
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
    cron: z.array(z.string()).default([]),
  })
  .refine(
    (config) => config.roles.length === 4 && new Set(config.roles).size === 4,
    { message: "Standalone deploys all roles in one process" },
  )
  .refine(
    (config) => !config.settings || Object.keys(config.settings).length === 0,
    { message: "Standalone does not support function resource settings" },
  );
export type StandaloneConfig = z.input<typeof configSchema>;
export const manifest: PlatformManifest = {
  id: "standalone",
  kind: "platform",
  runtime: "node",
  compute: "long-lived",
  configSchema,
  capabilities: {},
  runtimes: ["node"],
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<StandaloneConfig> = {
  module: { provider: "local", component: "standalone", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {},
  grants: [],
};
export function standalone(config: StandaloneConfig = {}): PlatformSelection {
  return {
    manifest,
    infra,
    runtimeModule: "@errtraq/platform-standalone",
    config,
    dependsOn: { store: "store", queue: "queue", blobs: "blob", kv: "kv" },
  };
}
