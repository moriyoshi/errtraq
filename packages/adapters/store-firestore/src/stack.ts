import {
  type AdapterManifest,
  type AdapterSelection,
  type InfraDescriptor,
  type InfraValue,
  out,
  stackValue,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";
import { fieldExemptions, terraformIndexes } from "./indexes.js";

export const configSchema = z.strictObject({
  /** The GCP project that owns the database. */
  projectId: z.string().min(1),
  /** Firestore location, always explicit (no default region; it is immutable after creation). */
  location: z.string().min(1),
  /** Defaults to a database named after the stack, delivered through the binding. */
  databaseId: z.string().min(1).optional(),
  /** Emulator or alternative endpoint origin; otherwise `FIRESTORE_EMULATOR_HOST` is honored. */
  emulatorEndpoint: z.url().optional(),
  requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
  transactionTimeoutMs: z.number().int().min(1).max(270000).optional(),
});
export type Config = z.input<typeof configSchema>;
export const DATABASE_BINDING = "ERRTRAQ_STORE_DATABASE";

export const manifest: AdapterManifest = {
  id: "store-firestore",
  kind: "store",
  configSchema,
  runtimes: ["node", "workers"],
  requires: [],
  capabilities: {
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
    recordEvents: true,
    deleteStrategy: "explicit",
    deleteBySubject: false,
  },
};

const policy = (capability: string) => ({
  primary: out("policies", capability, "primary"),
});
/**
 * HCL module contract. TODO(G6): `infra/modules/gcp/firestore` does not exist yet; the output
 * names below are the placeholder shape G6 implements. Firestore has no key-prefix narrowing, so
 * `key-read`, `project-read` and `release-read` resolve to the same read binding as `read`.
 */
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "gcp",
    component: "firestore",
    outputs: {
      database_id: "string",
      project_id: "string",
      policies: { map: { map: "json-document" } },
    },
  },
  inputs: (config) => ({
    name: stackValue("name"),
    protection: stackValue("protection"),
    labels: stackValue("tags"),
    purpose: "store",
    project_id: config.projectId,
    location: config.location,
    database_id: config.databaseId ?? null,
    composite_indexes: terraformIndexes() as unknown as InfraValue,
    field_exemptions: fieldExemptions.map((e) => ({
      collection: e.collection,
      field: e.field,
    })) as unknown as InfraValue,
  }),
  resources: { primary: out("database_id") },
  capabilities: {
    "key-read": policy("read"),
    "project-read": policy("read"),
    "release-read": policy("read"),
    read: policy("read"),
    write: policy("write"),
    delete: policy("delete"),
    "metadata-delete": policy("metadata-delete"),
  },
  bindings: [
    {
      name: DATABASE_BINDING,
      kind: "env",
      purpose: "primary",
      value: out("database_id"),
    },
  ],
};
export function firestoreStore(config: Config): AdapterSelection<Config> {
  return {
    manifest,
    infra,
    config,
    runtimeModule: "@moriyoshi/errtraq-store-firestore/runtime",
  };
}
