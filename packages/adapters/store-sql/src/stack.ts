import {
  type AdapterManifest,
  type AdapterSelection,
  configReference,
  type InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";

export const configSchema = z.strictObject({ path: z.string().min(1) });
export type SqliteConfig = z.infer<typeof configSchema>;
const stackConfigSchema = z.strictObject({
  path: configReference(z.string().min(1)),
});
type SqliteStackConfig = z.input<typeof stackConfigSchema>;
export const manifest: AdapterManifest = {
  id: "sqlite",
  kind: "store",
  configSchema: stackConfigSchema,
  runtimes: ["node"],
  requires: [
    "writable-filesystem",
    "long-lived-process",
    "shared-process-state",
  ],
  capabilities: {
    deleteStrategy: "explicit",
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
    recordEvents: true,
  },
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<SqliteStackConfig> = {
  module: { provider: "local", component: "sqlite", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {
    "key-read": { primary: null },
    "project-read": { primary: null },
    read: { primary: null },
    write: { primary: null },
    delete: { primary: null },
    "metadata-delete": { primary: null },
  },
  resources: { primary: "local" },
};
export function sqlite(
  config: SqliteStackConfig,
): AdapterSelection<SqliteStackConfig> {
  return { manifest, infra, runtimeModule: "@errtraq/store-sql", config };
}
