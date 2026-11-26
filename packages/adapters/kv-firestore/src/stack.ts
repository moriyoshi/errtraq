import {
  type AdapterManifest,
  type AdapterSelection,
  type InfraDescriptor,
  type InfraValue,
  out,
  stackValue,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";

export const configSchema = z.strictObject({
  /** The GCP project that owns the database. */
  projectId: z.string().min(1),
  /** Firestore location, always explicit (no default region; it is immutable after creation). */
  location: z.string().min(1),
  databaseId: z.string().min(1).optional(),
  /** Emulator or alternative endpoint origin; otherwise `FIRESTORE_EMULATOR_HOST` is honored. */
  emulatorEndpoint: z.url().optional(),
  requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
  /** Bound on the retries of one increment under contention. */
  overallTimeoutMs: z.number().int().min(1).max(300000).optional(),
});
export type Config = z.input<typeof configSchema>;
export const DATABASE_BINDING = "ERRTRAQ_KV_DATABASE";
/** Collection and field of the Firestore TTL policy (deletion lags up to a day; reads check). */
export const TTL_COLLECTION = "kv";
export const TTL_FIELD = "expireAt";
/** Every field of a `kv/{key}` document (see the runtime). */
export const KV_FIELDS = ["v", "n", "c", TTL_FIELD] as const;

export const manifest: AdapterManifest = {
  id: "kv-firestore",
  kind: "kv",
  configSchema,
  runtimes: ["node", "workers"],
  requires: [],
  capabilities: {},
};

const policy = (capability: string) => ({
  primary: out("policies", capability, "primary"),
});
/**
 * HCL module contract (`infra/modules/google/firestore`): a database of its own for purpose `kv`,
 * with the TTL policy and every document field exempt from single-field indexing.
 */
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "google",
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
    purpose: "kv",
    project_id: config.projectId,
    location: config.location,
    database_id: config.databaseId ?? null,
    ttl_policies: [
      { collection: TTL_COLLECTION, field: TTL_FIELD },
    ] as unknown as InfraValue,
    // KV reads documents by key and never queries, so no field needs a single-field index; the
    // TTL timestamp especially must not have one (monotonic values hotspot the index).
    field_exemptions: KV_FIELDS.map((field) => ({
      collection: TTL_COLLECTION,
      field,
    })) as unknown as InfraValue,
  }),
  resources: { primary: out("database_id") },
  capabilities: {
    read: policy("read"),
    write: policy("write"),
    delete: policy("delete"),
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
export function firestoreKv(config: Config): AdapterSelection<Config> {
  return {
    manifest,
    infra,
    config,
    runtimeModule: "@moriyoshi/errtraq-kv-firestore/runtime",
  };
}
