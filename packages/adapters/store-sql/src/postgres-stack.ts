import {
  type AdapterManifest,
  type AdapterSelection,
  type EnvRef,
  type InfraDescriptor,
  isEnvRef,
  isVariableRef,
  out,
  type VariableRef,
} from "@errtraq/core";
import { z } from "zod";

const stringRef = z.custom<VariableRef | EnvRef>(
  (v) =>
    isVariableRef(v) ||
    (isEnvRef(v) && v.phase === "runtime" && v.valueType === undefined),
);
const iamSchema = z.strictObject({
  mode: z.literal("iam"),
  host: z
    .string()
    .min(1)
    .regex(/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)
    .refine((v) => !v.includes("..")),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.@-]{0,62}$/),
  region: z.string().regex(/^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$/),
  resourceId: z.string().regex(/^(db|cluster|prx)-[A-Za-z0-9]+$/),
  sslRootCert: z.union([z.string().min(1), stringRef]).optional(),
});
const secretModeSchema = z.strictObject({ mode: z.literal("secret") });
const iamModeSchema = iamSchema.omit({ sslRootCert: true });
const modeSchema = z.discriminatedUnion("mode", [
  secretModeSchema,
  iamModeSchema,
]);
type Config = z.infer<typeof modeSchema>;
export const manifest: AdapterManifest = {
  id: "postgres",
  kind: "store",
  configSchema: secretModeSchema,
  runtimes: ["node"],
  requires: [],
  capabilities: {
    deleteStrategy: "explicit",
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
    recordEvents: true,
  },
};
export const infra: InfraDescriptor<Config> = {
  module: { provider: "local", component: "postgres", outputs: {} },
  inputs: () => ({}),
  resources: { primary: "external" },
  capabilities: {
    "key-read": { primary: null },
    read: { primary: null },
    write: { primary: null },
    delete: { primary: null },
    "metadata-delete": { primary: null },
  },
  bindings: [],
};
export type PostgresIamConfig = z.input<typeof iamSchema>;
export type PostgresSecretConfig = { mode: "secret"; secret: VariableRef };
/** Existing database: a secret identifier or a role-bound RDS IAM identity. */
export function postgres(
  input: VariableRef | PostgresSecretConfig | PostgresIamConfig,
): AdapterSelection {
  if (isVariableRef(input) || input.mode === "secret") {
    const secret = isVariableRef(input) ? input : input.secret;
    if (
      !isVariableRef(secret) ||
      (!isVariableRef(input) &&
        Object.keys(input).some((key) => !["mode", "secret"].includes(key)))
    )
      throw new Error("Invalid Postgres secret authentication configuration");
    return {
      manifest: {
        ...manifest,
        adapterAuthorization: "secret-binding",
        capabilities: {
          ...manifest.capabilities,
          authorizationScope:
            "Secrets Manager supplies one PostgreSQL user; PostgreSQL privileges enforce read, write and delete.",
        },
      },
      infra: {
        ...infra,
        bindings: [
          {
            name: "ERRTRAQ_POSTGRES_SECRET",
            kind: "secret",
            purpose: "primary",
            value: secret,
          },
        ],
      },
      runtimeModule: "@errtraq/store-sql/postgres",
      config: { mode: "secret" },
      existing: {},
    };
  }
  const config = iamSchema.parse(input);
  const names = {
    ERRTRAQ_POSTGRES_HOST: config.host,
    ERRTRAQ_POSTGRES_PORT: String(config.port),
    ERRTRAQ_POSTGRES_DATABASE: config.database,
    ERRTRAQ_POSTGRES_USER: config.user,
    ERRTRAQ_POSTGRES_REGION: config.region,
    ERRTRAQ_POSTGRES_CA_PATH: config.sslRootCert ?? "/var/runtime/ca-cert.pem",
  };
  const iamInfra: InfraDescriptor<Config> = {
    module: {
      provider: "aws",
      component: "rds-iam-access",
      outputs: { policies: { map: { map: "json-document" } } },
    },
    inputs: () => ({
      resource_id: config.resourceId,
      database_user: config.user,
      region: config.region,
    }),
    resources: { primary: "external" },
    capabilities: {
      "key-read": { primary: out("policies", "read", "primary") },
      read: { primary: out("policies", "read", "primary") },
      write: { primary: out("policies", "write", "primary") },
      delete: { primary: out("policies", "delete", "primary") },
      "metadata-delete": { primary: out("policies", "write", "primary") },
    },
    bindings: Object.entries(names).map(([name, value]) => ({
      name,
      kind: "env" as const,
      purpose: "primary",
      value,
    })),
  };
  return {
    manifest: {
      ...manifest,
      configSchema: iamModeSchema,
      capabilities: {
        ...manifest.capabilities,
        authorizationScope:
          "IAM grants connection to one PostgreSQL user; PostgreSQL privileges enforce read, write and delete.",
      },
      requires: ["aws-credentials"],
    },
    infra: iamInfra,
    runtimeModule: "@errtraq/store-sql/postgres",
    config: {
      mode: "iam",
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      region: config.region,
      resourceId: config.resourceId,
    },
  };
}
