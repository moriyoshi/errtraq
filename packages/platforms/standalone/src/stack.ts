import type {
  InfraDescriptor,
  PlatformManifest,
  PlatformSelection,
} from "@errtraq/core";
import { z } from "zod";
export const configSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8787),
  rateLimit: z.number().int().positive().nullable().default(60),
  rateWindowSec: z.number().int().positive().default(60),
});
export type StandaloneConfig = z.input<typeof configSchema>;
export const manifest: PlatformManifest = {
  id: "standalone",
  kind: "platform",
  runtime: "node",
  compute: "long-lived",
  functions: ["ingest", "api", "consumer", "cron"],
  configSchema,
  capabilities: {},
  runtimes: ["node"],
};
// TODO(M2a): replace the placeholder local descriptor when the infra model is revised.
export const infra: InfraDescriptor<StandaloneConfig> = {
  module: "local/standalone",
  inputs: () => ({}),
  bindings: {},
  grants: [],
  triggers: [],
};
export function standalone(config: StandaloneConfig = {}): PlatformSelection {
  return {
    manifest,
    infra,
    runtimeModule: "@errtraq/platform-standalone",
    config,
  };
}
