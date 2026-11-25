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
 * HCL module contract. TODO(G6): `infra/modules/gcp/firestore` does not exist yet; this is the
 * placeholder shape G6 implements (a database of its own for purpose `kv`, with the TTL policy).
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
    purpose: "kv",
    project_id: config.projectId,
    location: config.location,
    database_id: config.databaseId ?? null,
    ttl_policies: [
      { collection: TTL_COLLECTION, field: TTL_FIELD },
    ] as unknown as InfraValue,
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
