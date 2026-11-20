import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";

export const configSchema = z.strictObject({ path: z.string().min(1) });
export type SqliteConfig = z.infer<typeof configSchema>;
export const manifest: AdapterManifest<SqliteConfig> = {
  id: "sqlite",
  kind: "store",
  configSchema,
  runtimes: ["node"],
  capabilities: {
    deleteStrategy: "explicit",
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
  },
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<SqliteConfig> = {
  module: { provider: "local", component: "sqlite", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {},
  grants: [],
};
export function sqlite(config: SqliteConfig): AdapterSelection<SqliteConfig> {
  return { manifest, infra, runtimeModule: "@errtraq/store-sql", config };
}
