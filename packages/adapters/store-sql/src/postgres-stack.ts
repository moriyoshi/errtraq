import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
  VariableRef,
} from "@errtraq/core";
import { z } from "zod";

export const manifest: AdapterManifest = {
  id: "postgres",
  kind: "store",
  configSchema: z.strictObject({}),
  runtimes: ["node"],
  requires: [],
  capabilities: {
    deleteStrategy: "explicit",
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
  },
};
export function postgres(secret: VariableRef): AdapterSelection {
  const infra: InfraDescriptor<Record<string, never>> = {
    module: { provider: "local", component: "postgres", outputs: {} },
    inputs: () => ({}),
    resources: { primary: "external" },
    capabilities: {
      read: { primary: null },
      write: { primary: null },
      delete: { primary: null },
    },
    bindings: [
      {
        name: "ERRTRAQ_POSTGRES_SECRET",
        kind: "secret",
        purpose: "primary",
        value: secret,
      },
    ],
  };
  return {
    manifest,
    infra,
    runtimeModule: "@errtraq/store-sql/postgres",
    config: {},
    existing: {},
  };
}
export const infra: InfraDescriptor<Record<string, never>> = {
  module: { provider: "local", component: "postgres", outputs: {} },
  inputs: () => ({}),
  resources: { primary: "external" },
  capabilities: {
    read: { primary: null },
    write: { primary: null },
    delete: { primary: null },
  },
  bindings: [],
};
