import {
  deriveDeployment,
  resolveStack,
  validateStack,
  variable,
} from "@moriyoshi/errtraq-core";
import { awsLambda } from "@moriyoshi/errtraq-platform-aws-lambda/stack";
import { postgres } from "@moriyoshi/errtraq-store-sql/postgres/stack";
import { describe, expect, it } from "vitest";
import grouped from "./aws-dynamodb.js";

const copy = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value)) as T;
const ADMIN = "ERRTRAQ_POSTGRES_ADMIN_SECRET";
const adminArn =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-ABC123-XYZ789";
const iam = (adminSecret?: ReturnType<typeof variable>) =>
  postgres({
    mode: "iam",
    host: "db.example.rds.amazonaws.com",
    database: "errtraq",
    user: "app_user",
    region: "us-east-1",
    resourceId: "db-ABC123",
    ...(adminSecret ? { adminSecret } : {}),
  });
const variables = {
  ADMIN_SECRET_ARN: {
    type: "string" as const,
    sensitive: false,
    default: adminArn,
  },
};
const roles = ["ingest", "api", "consumer", "cron", "bootstrap"] as const;
const withBootstrap = (extra: Record<string, unknown> = {}) => ({
  ...copy(grouped),
  recordMode: "direct" as const,
  platform: awsLambda({
    roles: [...roles],
    bootstrapSecretName: "errtraq/bootstrap/test",
  }),
  ...extra,
});
const names = (items: { binding: { name: string } }[]) =>
  items.map((item) => item.binding.name).sort();

describe("optional bootstrap role", () => {
  it("is absent unless the platform enables it", () => {
    const view = deriveDeployment(
      resolveStack({
        ...copy(grouped),
        recordMode: "direct",
        platform: awsLambda(),
      }),
    );
    expect(view.functions.some((fn) => fn.roles.includes("bootstrap"))).toBe(
      false,
    );
  });
  it("is its own untriggered function with store and KV access only (DynamoDB)", () => {
    const stack = withBootstrap();
    expect(validateStack(stack)).toEqual([]);
    const view = deriveDeployment(resolveStack(stack));
    const fn = view.functions.find((item) => item.roles.includes("bootstrap"));
    expect(fn).toMatchObject({
      id: "bootstrap",
      roles: ["bootstrap"],
      http: [],
    });
    // Even a stack that groups everything else never groups bootstrap into `shared`.
    const grouped2 = resolveStack(
      withBootstrap({
        platform: awsLambda({
          roles: [...roles],
          split: [],
          bootstrapSecretName: "errtraq/bootstrap/test",
        }),
      }),
    );
    expect(
      deriveDeployment(grouped2).functions.map((item) => item.roles.join("+")),
    ).toEqual(["bootstrap", "ingest+api+consumer+cron"]);
    expect(view.triggers.some((trigger) => trigger.functionId === fn?.id)).toBe(
      false,
    );
    expect(
      fn?.policies.map((p) => `${p.selection}:${p.capability}`).sort(),
    ).toEqual(["kv:read", "kv:write", "store:read", "store:write"]);
    expect(names(fn?.envBindings ?? [])).toEqual([
      "ERRTRAQ_KV_TABLE",
      "ERRTRAQ_STORE_TABLE",
    ]);
    expect(fn?.secretBindings).toEqual([]);
    expect(fn?.secretReads).toEqual([]);
    // Nothing is added to the runtime functions.
    const baseline = deriveDeployment(
      resolveStack({
        ...copy(grouped),
        recordMode: "direct",
        platform: awsLambda(),
      }),
    );
    for (const runtime of view.functions.filter((item) => item !== fn))
      expect(runtime.policies).toEqual(
        baseline.functions.find((item) => item.id === runtime.id)?.policies,
      );
  });
  it("delivers the Postgres administrator secret to the bootstrap role alone", () => {
    const stack = withBootstrap({
      store: iam(variable("ADMIN_SECRET_ARN")),
      variables,
    });
    expect(validateStack(stack)).toEqual([]);
    const view = deriveDeployment(resolveStack(stack));
    for (const fn of view.functions) {
      const hasAdmin = [...fn.envBindings, ...fn.secretBindings].some(
        (item) => item.binding.name === ADMIN,
      );
      const adminRead = fn.secretReads.some(
        (item) => item.bindingName === ADMIN,
      );
      expect(hasAdmin, fn.id).toBe(fn.roles.includes("bootstrap"));
      expect(adminRead, fn.id).toBe(fn.roles.includes("bootstrap"));
    }
    const bootstrap = view.functions.find((fn) => fn.id === "bootstrap");
    expect(bootstrap?.secretBindings.map((item) => item.binding)).toEqual([
      expect.objectContaining({ name: ADMIN, kind: "secret" }),
    ]);
    // The IAM connect grant is the same one the runtime roles use: no extra database access.
    expect(
      bootstrap?.policies.map((p) => `${p.selection}:${p.capability}`).sort(),
    ).toEqual(["kv:read", "kv:write", "store:read", "store:write"]);
  });
  it("leaves runtime roles alone when adminSecret is configured but bootstrap is not", () => {
    const stack = {
      ...copy(grouped),
      recordMode: "direct" as const,
      platform: awsLambda(),
      store: iam(variable("ADMIN_SECRET_ARN")),
      variables,
    };
    expect(validateStack(stack)).toEqual([]);
    for (const fn of deriveDeployment(resolveStack(stack)).functions) {
      expect(fn.secretBindings).toEqual([]);
      expect(fn.secretReads).toEqual([]);
    }
  });
  it("requires a bootstrap secret name exactly when the role is enabled", () => {
    expect(() => awsLambda({ roles: [...roles] })).toThrow();
    expect(() => awsLambda({ bootstrapSecretName: "errtraq/x" })).toThrow();
    expect(() =>
      awsLambda({ roles: [...roles], bootstrapSecretName: "bad name" }),
    ).toThrow();
    expect(
      awsLambda({ roles: [...roles], bootstrapSecretName: "errtraq/x" }).config,
    ).toMatchObject({ settings: { bootstrap: { timeoutSec: 120 } } });
  });
  it("keeps the secret name binding reserved from adapters", () => {
    expect(awsLambda().manifest.reservedBindings).toContain(
      "ERRTRAQ_BOOTSTRAP_SECRET_NAME",
    );
  });
});
