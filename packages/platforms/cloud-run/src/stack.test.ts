import { variable } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import {
  cloudRun,
  configSchema,
  FUNCTION_DEFAULTS,
  manifest,
} from "./stack.js";

const base = {
  projectId: "example-project",
  region: "europe-west1",
  image: variable("CLOUD_RUN_IMAGE"),
};
const digest = `registry.example/team/app@sha256:${"b".repeat(64)}`;

describe("cloud-run config", () => {
  it("requires an explicit project and region, never defaulting them", () => {
    expect(() => configSchema.parse({ image: base.image })).toThrow();
    const { region: _region, ...noRegion } = base;
    expect(() => configSchema.parse(noRegion)).toThrow();
    const { projectId: _project, ...noProject } = base;
    expect(() => configSchema.parse(noProject)).toThrow();
    expect(() => configSchema.parse({ ...base, region: "tokyo" })).toThrow();
  });
  it("accepts an image by digest or a stack variable and rejects a tag", () => {
    expect(cloudRun({ ...base, image: digest }).config).toMatchObject({
      image: digest,
    });
    expect(cloudRun(base).config).toMatchObject({ image: base.image });
    expect(() =>
      cloudRun({ ...base, image: "registry.example/team/app:latest" }),
    ).toThrow();
  });
  it("defaults the roles like the AWS platform and the consumer timeout to 30 s", () => {
    const config = configSchema.parse(base);
    expect(config.roles).toEqual(["ingest", "api", "consumer", "cron"]);
    expect(config.settings.consumer?.timeoutSec).toBe(30);
    expect(config.oidcAudience).toBe("errtraq-push");
  });
  it("bounds the per-role settings", () => {
    for (const settings of [
      { ingest: { concurrency: 1001 } },
      { ingest: { cpu: 9 } },
      { ingest: { timeoutSec: 3601 } },
      { ingest: { ingress: "everywhere" } },
      { ingest: { vpcEgress: "none" } },
      { ingest: { unknown: 1 } },
    ])
      expect(() => configSchema.parse({ ...base, settings })).toThrow();
    expect(
      configSchema.parse({
        ...base,
        settings: {
          ingest: {
            memoryMb: 1024,
            cpu: 2,
            timeoutSec: 60,
            concurrency: 40,
            minInstances: 1,
            maxInstances: 5,
            ingress: "internal",
            vpcEgress: "all-traffic",
          },
        },
      }).settings.ingest,
    ).toMatchObject({ maxInstances: 5, vpcEgress: "all-traffic" });
  });
  it("ties the bootstrap secret name to the bootstrap role", () => {
    expect(() =>
      configSchema.parse({ ...base, roles: ["ingest", "bootstrap"] }),
    ).toThrow();
    expect(() =>
      configSchema.parse({ ...base, bootstrapSecretName: "errtraq-bootstrap" }),
    ).toThrow();
    expect(
      configSchema.parse({
        ...base,
        roles: ["ingest", "bootstrap"],
        split: ["ingest", "bootstrap"],
        bootstrapSecretName: "errtraq-bootstrap",
      }).settings.bootstrap?.timeoutSec,
    ).toBe(120);
  });
});
describe("cloud-run operatorMembers", () => {
  const withBootstrap = {
    ...base,
    roles: ["ingest", "bootstrap"] as ("ingest" | "bootstrap")[],
    split: ["ingest", "bootstrap"] as ("ingest" | "bootstrap")[],
    bootstrapSecretName: "errtraq-bootstrap",
  };
  it("accepts named principals and defaults to none", () => {
    expect(configSchema.parse(base).operatorMembers).toEqual([]);
    const members = [
      "user:operator@example.com",
      "group:ops@example.com",
      "serviceAccount:ci@example-project.iam.gserviceaccount.com",
      "domain:example.com",
    ];
    expect(
      configSchema.parse({ ...withBootstrap, operatorMembers: members })
        .operatorMembers,
    ).toEqual(members);
  });
  it("rejects public and malformed members", () => {
    for (const member of [
      "allUsers",
      "allAuthenticatedUsers",
      "user:allUsers",
      "operator@example.com",
      "user:",
      "user:a@b.co extra",
      "projectOwner:example-project",
      "",
    ])
      expect(() =>
        configSchema.parse({ ...withBootstrap, operatorMembers: [member] }),
      ).toThrow();
  });
  it("is only valid with the bootstrap role", () => {
    expect(() =>
      configSchema.parse({
        ...base,
        operatorMembers: ["user:operator@example.com"],
      }),
    ).toThrow(/bootstrap role/);
  });
  it("feeds the module's operator_members variable", () => {
    const selection = cloudRun({
      ...withBootstrap,
      operatorMembers: ["group:ops@example.com"],
    });
    const inputs = selection.infra.inputs(selection.config, {
      functions: [],
      triggers: [],
    } as never) as Record<string, unknown>;
    expect(inputs.operator_members).toEqual(["group:ops@example.com"]);
  });
});
describe("cloud-run manifest", () => {
  it("declares what core drives behaviour from", () => {
    expect(manifest).toMatchObject({
      id: "cloud-run",
      runtime: "node",
      compute: "function",
      authorization: "iam",
      bindingKinds: ["env", "secret"],
      groupedRecordQueues: ["queue-pubsub"],
      minQueueDlqAttempts: 5,
      supportsArchive: false,
    });
    expect(manifest.provides).toContain("ambient-credentials");
    expect(manifest.reservedBindings).toContain("PORT");
  });
  it("describes functions for the module", () => {
    const selection = cloudRun({
      ...base,
      roles: ["ingest", "consumer", "cron"],
      split: ["ingest", "consumer", "cron"],
    });
    const view = {
      functions: ["ingest", "consumer", "cron"].map((id) => ({
        id,
        roles: [id],
        settings: id === "ingest" ? { maxInstances: 3, cpu: 2 } : {},
        artifact: { functionId: id },
        http: id === "ingest" ? ["ingest"] : [],
        envBindings: [],
        secretBindings: [],
        platformBindings: [],
        policies: [],
        secretReads: [],
      })),
      triggers: [],
    } as never;
    const inputs = selection.infra.inputs(selection.config, view) as {
      functions: Record<string, Record<string, unknown>>;
    };
    expect(inputs.functions.ingest).toMatchObject({
      public: true,
      max_instances: 3,
      cpu: 2,
      concurrency: FUNCTION_DEFAULTS.concurrency,
      command: ["node", "/app/ingest/index.mjs"],
    });
    expect(inputs.functions.consumer).toMatchObject({
      public: false,
      concurrency: FUNCTION_DEFAULTS.consumerConcurrency,
    });
    expect(inputs.functions.cron).toMatchObject({ concurrency: 1 });
    expect(inputs.functions.ingest?.environment).toMatchObject({
      ERRTRAQ_INGEST_RATE_LIMIT: "60",
      ERRTRAQ_OIDC_AUDIENCE: "errtraq-push",
      ERRTRAQ_PUSH_SERVICE_ACCOUNT:
        "errtraq-push@example-project.iam.gserviceaccount.com",
    });
    expect(inputs.functions.consumer?.environment).not.toHaveProperty(
      "ERRTRAQ_INGEST_RATE_LIMIT",
    );
  });
});
