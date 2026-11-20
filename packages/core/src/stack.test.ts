import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AdapterSelection,
  constructionOrder,
  defineStack,
  deriveTriggers,
  env,
  functionGroups,
  generationEnv,
  out,
  output,
  type PortKind,
  resolveStack,
  type StackConfig,
  selections,
  stackValue,
  validateStack,
  variable,
} from "./index.js";

const roles = ["ingest", "api", "consumer", "cron"] as const;
const route = (producer: "ingest" | "cron" | "consumer") => ({
  physical: "shared",
  producers: [producer],
  consumer: "consumer" as const,
  resource: out("arn"),
});
const selection = (kind: PortKind): AdapterSelection => ({
  manifest: {
    id: kind,
    kind,
    runtimes: ["node"],
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    capabilities:
      kind === "store"
        ? {
            textSearch: false,
            lastSeenRangeOnOtherSort: false,
            deleteStrategy: "explicit",
          }
        : kind === "queue"
          ? { delivery: "push", maxBytes: 100, delay: true, dlq: false }
          : {},
  },
  config: {},
  runtimeModule: `@test/${kind}`,
  infra: {
    module: {
      provider: kind === "queue" ? "local" : "aws",
      component: kind,
      outputs: { arn: "string", policy: "json" },
    },
    inputs: () => ({}),
    bindings: [],
    capabilities: {},
    grants: [],
    ...(kind === "queue"
      ? {
          topics: {
            mode: "shared",
            routes: {
              ingest: route("ingest"),
              "archive.project": route("cron"),
              notifications: route("consumer"),
            },
          },
        }
      : {}),
  },
});
function stack(): StackConfig {
  return {
    name: "test",
    region: "example-region",
    tags: { purpose: "test" },
    providers: { aws: { source: "hashicorp/aws", version: "~> 6.0" } },
    variables: { SECRET: { type: "string", sensitive: true } },
    platform: {
      ...selection("platform"),
      manifest: {
        ...selection("platform").manifest,
        kind: "platform",
        runtime: "node",
        compute: "function",
        configSchema: z.object({
          roles: z.array(z.enum(roles)),
          split: z.array(z.enum(roles)),
          cron: z.array(z.string()),
        }),
      },
      config: { roles: [...roles], split: [...roles], cron: [] },
    },
    store: selection("store"),
    queue: selection("queue"),
    blob: selection("blob"),
    kv: selection("kv"),
  };
}
function topics(v: StackConfig) {
  const value = v.queue.infra.topics;
  if (!value) throw new Error("Missing topic mapping");
  return value;
}
describe("infrastructure model", () => {
  it("validates and resolves adapter defaults without resolving refs", () => {
    const v = stack();
    v.store.infra.inputs = () => ({
      region: stackValue("region"),
      source: generationEnv("SOURCE"),
      secret: variable("SECRET"),
    });
    v.store.infra.bindings = [
      { name: "TOKEN", kind: "secret", roles: ["api"], value: env("TOKEN") },
    ];
    expect(validateStack(v)).toEqual([]);
    expect(resolveStack(v).store.config).toEqual({ enabled: true });
    expect(defineStack(v).store.infra.bindings[0]?.value).toEqual(env("TOKEN"));
  });
  it("rejects dangling selections, outputs, variables and runtime refs in module inputs", () => {
    const v = stack();
    v.store.infra.inputs = () => ({
      a: output("missing", "arn"),
      b: output("blob", "missing"),
      c: variable("MISSING"),
      d: env("TOKEN"),
    });
    expect(
      validateStack(v).filter((x) => x.path.includes("inputs")),
    ).toHaveLength(4);
  });
  it("rejects undeclared variable and provider names inherited from Object.prototype", () => {
    const v = stack();
    v.store.infra.inputs = () => ({ value: variable("constructor") });
    v.store.infra.module.provider = "constructor";
    const issues = validateStack(v);
    expect(
      issues.some((issue) => issue.message === "Unknown variable constructor"),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.message === "Missing provider requirement"),
    ).toBe(true);
  });
  it("allows ordinary kind fields in adapter configuration while checking tagged refs", () => {
    const v = stack();
    v.store.manifest.configSchema = z.object({
      kind: z.literal("custom"),
      nested: z.unknown(),
    });
    v.store.config = { kind: "custom", nested: env("TOKEN") };
    expect(validateStack(v)).toEqual([]);
    v.store.config = {
      kind: "custom",
      nested: { kind: "output", name: "missing" },
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Unknown output"),
      ),
    ).toBe(true);
  });
  it("rejects malformed references and missing stack region", () => {
    const v = stack();
    delete v.region;
    v.store.infra.inputs = () => ({
      a: { kind: "outptu", name: "x" },
      b: stackValue("region"),
    });
    expect(
      validateStack(v).filter((x) => x.path.includes("inputs")),
    ).toHaveLength(2);
  });
  it("substitutes existing outputs and requires every declared output", () => {
    const v = stack();
    v.blob.existing = { arn: variable("SECRET") };
    v.store.infra.inputs = () => ({ bucket: output("blob", "arn") });
    expect(
      validateStack(v).some((x) => x.path === "blob.existing.policy"),
    ).toBe(true);
    v.blob.existing.policy = generationEnv("EXTERNAL_POLICY");
    expect(validateStack(v)).toEqual([]);
    v.blob.existing.arn = out("arn");
    expect(validateStack(v).some((x) => x.message.includes("own output"))).toBe(
      true,
    );
  });
  it("rejects unknown existing output names", () => {
    const v = stack();
    v.blob.existing = { arn: "a", policy: "p", typo: "x" };
    expect(validateStack(v).some((x) => x.path === "blob.existing.typo")).toBe(
      true,
    );
  });
  it("checks existing replacement types and typed variable references", () => {
    const v = stack();
    v.blob.existing = { arn: 42, policy: "{}" };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Expected string output"),
      ),
    ).toBe(true);
    v.variables = { LIST: { type: "string[]", sensitive: false } };
    v.blob.existing.arn = variable("LIST");
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Expected string output"),
      ),
    ).toBe(true);
    v.blob.existing.arn = "external";
    expect(validateStack(v)).toEqual([]);
  });
  it("detects duplicate bindings by physical function and allows separate functions", () => {
    const v = stack();
    v.store.infra.bindings = [
      { name: "URL", kind: "env", roles: ["ingest"], value: "a" },
    ];
    v.blob.infra.bindings = [
      { name: "URL", kind: "env", roles: ["api"], value: "b" },
    ];
    expect(validateStack(v)).toEqual([]);
    (v.platform.config as { split: string[] }).split = [];
    expect(
      validateStack(v).some((x) => x.message.includes("Duplicate binding")),
    ).toBe(true);
  });
  it("validates role scopes, typed platform bindings and grants", () => {
    const v = stack();
    v.store.infra.bindings = [
      { name: "R2", kind: "platform", roles: ["api"], value: "bucket" },
    ];
    v.store.infra.grants = [
      {
        role: "api",
        capability: "read",
        resource: out("arn"),
        policy: out("policy"),
      },
    ];
    (v.platform.config as { roles: string[] }).roles = [
      "ingest",
      "consumer",
      "cron",
    ];
    expect(
      validateStack(v).some((x) => x.message.includes("does not deploy api")),
    ).toBe(true);
    expect(
      validateStack(v).some((x) => x.message.includes("requires a type")),
    ).toBe(true);
    expect(
      validateStack(v).some((x) => x.message.includes("Unknown capability")),
    ).toBe(true);
  });
  it("requires secret bindings to use sensitive or runtime references", () => {
    const v = stack();
    v.store.infra.bindings = [
      { name: "SECRET", kind: "secret", roles: ["api"], value: "plaintext" },
    ];
    expect(
      validateStack(v).some((x) =>
        x.message.includes("Secret binding must be a reference"),
      ),
    ).toBe(true);
    v.variables = { PUBLIC: { type: "string", sensitive: false } };
    v.store.infra.bindings[0] = {
      name: "SECRET",
      kind: "secret",
      roles: ["api"],
      value: variable("PUBLIC"),
    };
    expect(
      validateStack(v).some((x) => x.message.includes("must be sensitive")),
    ).toBe(true);
  });
  it("requires secret output references to be declared as such", () => {
    const v = stack();
    v.store.infra.bindings = [
      { name: "SECRET", kind: "secret", roles: ["api"], value: out("arn") },
    ];
    expect(validateStack(v).some((x) => x.message.includes("secret-ref"))).toBe(
      true,
    );
    v.store.infra.module.outputs.secret_id = "secret-ref";
    v.store.infra.bindings[0] = {
      name: "SECRET",
      kind: "secret",
      roles: ["api"],
      value: out("secret_id"),
    };
    expect(validateStack(v)).toEqual([]);
  });
  it("validates grant resource and policy output declarations", () => {
    const v = stack();
    v.store.infra.capabilities = { read: "policy" };
    v.store.infra.grants = [
      {
        role: "api",
        capability: "read",
        resource: out("arn"),
        policy: out("missing"),
      },
    ];
    expect(
      validateStack(v).some((x) => x.message.includes("Unknown output")),
    ).toBe(true);
    const grant = v.store.infra.grants[0];
    if (!grant) throw new Error("Missing grant");
    grant.policy = out("policy");
    expect(validateStack(v)).toEqual([]);
  });
  it("requires topic coverage, producer paths and one deployed consumer", () => {
    const v = stack();
    const routes = topics(v).routes;
    delete (routes as Partial<typeof routes>).ingest;
    expect(
      validateStack(v).some((x) => x.message.includes("Missing topic")),
    ).toBe(true);
    const n = stack();
    topics(n).routes.ingest.producers = [];
    expect(validateStack(n).length).toBeGreaterThan(0);
    const x = stack();
    topics(x).routes.ingest.consumer = "api";
    (x.platform.config as { roles: string[] }).roles = [
      "ingest",
      "consumer",
      "cron",
    ];
    expect(
      validateStack(x).some((i) => i.message.includes("does not deploy api")),
    ).toBe(true);
  });
  it("rejects undeclared producer binding names even for local queues", () => {
    const v = stack();
    topics(v).routes.ingest.producerBinding = "MISSING";
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Unknown producer binding"),
      ),
    ).toBe(true);
  });
  it("requires every cloud topic producer and consumer to have matching bindings and grants", () => {
    const v = stack();
    v.queue.infra.module.provider = "aws";
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Missing producer binding"),
      ),
    ).toBe(true);
    const q = v.queue.infra;
    q.capabilities = { produce: "policy", consume: "policy" };
    q.bindings = [
      {
        name: "QUEUE_URL",
        kind: "env",
        roles: ["ingest", "cron", "consumer"],
        value: out("arn"),
      },
    ];
    q.grants = [
      ...(["ingest", "cron", "consumer"] as const).map((role) => ({
        role,
        capability: "produce",
        resource: out("arn"),
        policy: out("policy"),
      })),
      {
        role: "consumer",
        capability: "consume",
        resource: out("arn"),
        policy: out("policy"),
      },
    ];
    for (const route of Object.values(topics(v).routes))
      route.producerBinding = "QUEUE_URL";
    expect(validateStack(v)).toEqual([]);
    q.grants = q.grants.map((grant) => ({
      ...grant,
      resource: output("queue", "arn"),
    }));
    expect(validateStack(v)).toEqual([]);
    q.grants = q.grants.filter((grant) => grant.role !== "cron");
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("lacks a resource grant"),
      ),
    ).toBe(true);
  });
  it("requires a single consumer and resource for a shared queue", () => {
    const v = stack();
    topics(v).routes.ingest.consumer = "api";
    expect(
      validateStack(v).some((issue) => issue.message.includes("one consumer")),
    ).toBe(true);
    const other = stack();
    topics(other).routes.ingest.resource = "different";
    expect(
      validateStack(other).some((issue) =>
        issue.message.includes("one resource"),
      ),
    ).toBe(true);
  });
  it("rejects undefined or non-JSON capability policies and self-output inputs", () => {
    const v = stack();
    v.store.infra.capabilities = { read: "arn" };
    v.store.infra.inputs = () => ({ self: out("arn") });
    expect(
      validateStack(v).some((issue) => issue.message.includes("JSON policy")),
    ).toBe(true);
    expect(
      validateStack(v).some((issue) => issue.message.includes("own output")),
    ).toBe(true);
  });
  it("validates physical shared and per-topic mapping", () => {
    const v = stack();
    topics(v).routes.ingest.physical = "different";
    expect(
      validateStack(v).some((x) => x.message.includes("same physical")),
    ).toBe(true);
    const n = stack();
    topics(n).mode = "per-topic";
    expect(validateStack(n).some((x) => x.message.includes("distinct"))).toBe(
      true,
    );
    topics(n).routes.ingest.physical = "one";
    topics(n).routes["archive.project"].physical = "two";
    topics(n).routes.notifications.physical = "three";
    expect(
      validateStack(n).some((x) => x.message.includes("distinct resources")),
    ).toBe(true);
    n.queue.infra.module.outputs = {
      one: "string",
      two: "string",
      three: "string",
    };
    topics(n).routes.ingest.resource = out("one");
    topics(n).routes["archive.project"].resource = out("two");
    topics(n).routes.notifications.resource = out("three");
    expect(validateStack(n)).toEqual([]);
  });
  it("derives one shared queue trigger and named cron triggers", () => {
    const v = stack();
    (v.platform.config as { cron: string[] }).cron = ["retention"];
    expect(deriveTriggers(v)).toEqual([
      {
        kind: "queue",
        physical: "shared",
        role: "consumer",
        resource: out("arn"),
        topics: ["ingest", "archive.project", "notifications"],
      },
      { kind: "cron", name: "retention", schedule: "15 * * * *", role: "cron" },
    ]);
  });
  it("checks named cron jobs, duplicate routes and deployed roles", () => {
    const v = stack();
    (v.platform.config as { cron: string[] }).cron = [
      "unknown",
      "retention",
      "retention",
    ];
    (v.platform.config as { roles: string[] }).roles = [
      "ingest",
      "api",
      "consumer",
    ];
    expect(
      validateStack(v).some((x) => x.message.includes("Unknown cron")),
    ).toBe(true);
    expect(
      validateStack(v).some((x) => x.message.includes("Duplicate cron")),
    ).toBe(true);
    expect(
      validateStack(v).some((x) => x.message.includes("does not deploy cron")),
    ).toBe(true);
  });
  it("derives split groups and validates role settings", () => {
    const v = stack();
    expect(
      functionGroups({ roles: [...roles], split: ["ingest"], cron: [] }),
    ).toEqual([["ingest"], ["api", "consumer", "cron"]]);
    (v.platform.config as { split: string[] }).split = ["api", "api"];
    expect(validateStack(v).some((x) => x.message.includes("Duplicate"))).toBe(
      true,
    );
  });
  it("traverses nested adapters and orders dependencies", () => {
    const v = stack();
    v.archive = selection("archive");
    v.archive.manifest.capabilities = { rowDelete: "copy-on-write" };
    v.archive.children = {
      catalog: selection("catalog"),
      engine: selection("engine"),
    };
    v.archive.dependsOn = { catalog: "archive.catalog", blob: "blob" };
    expect([...selections(v).keys()]).toContain("archive.catalog");
    const order = constructionOrder(v);
    expect(order.indexOf("archive.catalog")).toBeLessThan(
      order.indexOf("archive"),
    );
    expect(order.indexOf("blob")).toBeLessThan(order.indexOf("archive"));
  });
  it("rejects dangling dependencies and cycles in each dependency graph", () => {
    const v = stack();
    v.store.dependsOn = { foo: "missing", blob: "blob" };
    v.blob.dependsOn = { store: "store" };
    expect(
      validateStack(v).some((x) => x.message.includes("Unknown selection")),
    ).toBe(true);
    expect(
      validateStack(v).some((x) =>
        x.message.includes("Runtime dependency cycle"),
      ),
    ).toBe(true);
    const modules = stack();
    modules.store.infra.inputs = () => ({ other: output("blob", "arn") });
    modules.blob.infra.inputs = () => ({ other: output("store", "arn") });
    expect(
      validateStack(modules).some((x) =>
        x.message.includes("Module dependency cycle"),
      ),
    ).toBe(true);
    const independent = stack();
    independent.store.dependsOn = { blob: "blob" };
    independent.blob.infra.inputs = () => ({ other: output("store", "arn") });
    expect(validateStack(independent)).toEqual([]);
  });
  it("restricts backend configuration to generation-time values", () => {
    const v = stack();
    v.backend = {
      type: "s3",
      config: { bucket: output("blob", "arn"), key: variable("SECRET") },
    };
    expect(
      validateStack(v).filter((x) =>
        x.message.includes("Backend config requires"),
      ),
    ).toHaveLength(2);
    v.backend.config = {
      bucket: generationEnv("BACKEND_BUCKET"),
      key: "state.tfstate",
    };
    expect(validateStack(v)).toEqual([]);
  });
  it("requires provider metadata and enforces runtime and capabilities", () => {
    const v = stack();
    delete v.providers;
    v.kv.manifest.runtimes = ["worker"];
    v.requirements = { store: { textSearch: true } };
    expect(validateStack(v).some((x) => x.message.includes("provider"))).toBe(
      true,
    );
    expect(validateStack(v).some((x) => x.message.includes("runtime"))).toBe(
      true,
    );
    expect(validateStack(v).some((x) => x.message.includes("Requires"))).toBe(
      true,
    );
  });
  it("rejects requirements for unknown selection paths", () => {
    const v = stack();
    v.requirements = { missing: {} };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Unknown selection"),
      ),
    ).toBe(true);
  });
  it("rejects pull-only queues on function platforms", () => {
    const v = stack();
    v.queue.manifest.capabilities.delivery = "pull";
    expect(validateStack(v).some((x) => x.message.includes("Pull-only"))).toBe(
      true,
    );
    v.platform.manifest.compute = "long-lived";
    expect(validateStack(v)).toEqual([]);
  });
  it("rejects unknown fields, bad configs and throwing schemas", () => {
    const v = stack();
    v.blob.manifest.configSchema = z.any().transform(() => {
      throw new Error("bad");
    });
    expect(validateStack(v).some((x) => x.path === "blob.config")).toBe(true);
    expect(validateStack({ ...stack(), typo: true }).length).toBeGreaterThan(0);
  });
});
