import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AdapterSelection,
  bindingsForRoles,
  configReference,
  constructionOrder,
  defineStack,
  deriveAccess,
  deriveTriggers,
  env,
  generationEnv,
  isEnvRef,
  isInfraRef,
  isOutputRef,
  isStackRef,
  isVariableRef,
  out,
  output,
  type PortKind,
  physicalFunctions,
  REF,
  resolveStack,
  type StackConfig,
  selections,
  stackValue,
  validateStack,
  variable,
} from "./index.js";

const roles = ["ingest", "api", "consumer", "cron"] as const;
const route = () => ({ physical: "shared", producerBinding: "QUEUE_URL" });
const selection = (kind: PortKind): AdapterSelection => ({
  manifest: {
    id: kind,
    kind,
    runtimes: ["node"],
    requires: [],
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
    bindings:
      kind === "queue"
        ? [
            {
              name: "QUEUE_URL",
              kind: "env",
              purpose: "shared",
              value: out("arn"),
            },
          ]
        : [],
    capabilities:
      kind === "queue"
        ? { produce: "policy", consume: "policy" }
        : kind === "store"
          ? { read: "policy", write: "policy", delete: "policy" }
          : kind === "blob"
            ? {
                read: "policy",
                write: "policy",
                delete: "policy",
                list: "policy",
              }
            : kind === "kv"
              ? { read: "policy", write: "policy" }
              : kind === "archive"
                ? { read: "policy", write: "policy", delete: "policy" }
                : {},
    resources:
      kind === "queue"
        ? { shared: out("arn") }
        : { primary: out("arn"), staging: out("arn") },
    ...(kind === "queue"
      ? {
          topics: {
            mode: "shared",
            routes: {
              ingest: route(),
              "archive.project": route(),
              notifications: route(),
            },
          },
        }
      : {}),
  },
});
function stack(): StackConfig {
  return {
    name: "test",
    providers: {
      aws: {
        source: "hashicorp/aws",
        version: "~> 6.0",
        region: "example-region",
        tags: { purpose: "test" },
      },
    },
    variables: { SECRET: { type: "string", sensitive: true } },
    platform: {
      ...selection("platform"),
      manifest: {
        ...selection("platform").manifest,
        kind: "platform",
        runtime: "node",
        compute: "function",
        provides: [],
        authorization: "iam",
        bindingKinds: ["env", "secret"],
        reservedBindings: [],
        configSchema: z
          .object({
            roles: z.array(z.enum(roles)),
            split: z.array(z.enum(roles)),
            cron: z.array(z.string()),
          })
          .passthrough(),
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
  it("does not parse transformed configuration a second time", () => {
    const v = stack();
    v.blob.manifest.configSchema = z.object({
      n: z.string().transform(Number),
    });
    v.blob.config = { n: "5" };
    const resolved = resolveStack(v);
    expect(resolved.blob.config).toEqual({ n: 5 });
    expect(resolveStack(resolved)).toBe(resolved);
    expect(constructionOrder(resolved)).toContain("blob");
    expect(deriveTriggers(resolved)).toHaveLength(1);
    expect(validateStack(resolved)).toEqual([]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.blob.config)).toBe(true);
    expect(Object.isFrozen(resolved.queue.infra.topics?.routes.ingest)).toBe(
      true,
    );
    expect(() =>
      Object.assign(resolved.blob.config as object, { n: 9 }),
    ).toThrow();
    expect(v.blob.config).toEqual({ n: "5" });
    expect(Object.isFrozen(v.blob.config)).toBe(false);
  });
  it("distinguishes all reference types from ordinary kind-bearing data", () => {
    expect(REF).toBe(Symbol.for("@errtraq/infra-reference"));
    expect(isOutputRef(out("id"))).toBe(true);
    expect(isStackRef(stackValue("name"))).toBe(true);
    expect(isEnvRef(env("TOKEN"))).toBe(true);
    expect(isVariableRef(variable("SECRET"))).toBe(true);
    expect(isInfraRef({ kind: "output", name: "id" })).toBe(false);
  });
  it("allows runtime and variable config references but rejects generation and output references even with permissive schemas", () => {
    const v = stack();
    v.store.manifest.configSchema = z.object({
      path: configReference(z.string()),
    });
    v.store.config = { path: env("DATA") };
    expect(validateStack(v)).toEqual([]);
    v.store.config = { path: variable("SECRET") };
    expect(validateStack(v)).toEqual([]);
    v.store.config = { path: generationEnv("DATA") };
    expect(validateStack(v).length).toBeGreaterThan(0);
    v.store.manifest.configSchema = z.any();
    for (const ref of [
      generationEnv("DATA"),
      output("blob", "arn"),
      stackValue("name"),
    ]) {
      v.store.config = { nested: ref };
      expect(
        validateStack(v).some((issue) =>
          issue.message.includes("Only runtime environment"),
        ),
      ).toBe(true);
    }
    v.store.manifest.configSchema = z.object({ nested: z.coerce.string() });
    v.store.config = { nested: output("blob", "arn") };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Only runtime environment"),
      ),
    ).toBe(true);
  });
  it("resolves provider values against the owner or an explicit provider", () => {
    const v = stack();
    v.providers = {
      ...v.providers,
      cloudflare: {
        source: "cloudflare/cloudflare",
        version: "~> 5",
        tags: { region: "other" },
      },
    };
    v.store.infra.inputs = () => ({
      region: stackValue("region"),
      tags: stackValue("tags", "cloudflare"),
    });
    expect(validateStack(v)).toEqual([]);
    v.store.infra.inputs = () => ({
      region: stackValue("region", "cloudflare"),
      tags: stackValue("tags", "missing"),
    });
    const issues = validateStack(v);
    expect(issues.some((i) => i.message.includes("region is missing"))).toBe(
      true,
    );
    expect(
      issues.some((i) => i.message.includes("Unknown provider missing")),
    ).toBe(true);
  });
  it("validates and resolves adapter defaults without resolving refs", () => {
    const v = stack();
    v.store.infra.inputs = () => ({
      region: stackValue("region"),
      source: generationEnv("SOURCE"),
      secret: variable("SECRET"),
    });
    v.store.infra.bindings = [
      {
        name: "TOKEN",
        kind: "secret",
        purpose: "primary",
        value: env("TOKEN"),
      },
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
      nested: output("missing", "missing"),
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Only runtime environment"),
      ),
    ).toBe(true);
  });
  it("rejects malformed references and missing stack region", () => {
    const v = stack();
    if (v.providers?.aws) delete v.providers.aws.region;
    v.store.infra.inputs = () => ({
      a: Object.defineProperty(out("x"), REF, { value: "outptu" }),
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
  it("derives binding scopes and detects duplicate names within a physical function", () => {
    const v = stack();
    v.store.infra.bindings = [
      { name: "DB", kind: "env", purpose: "primary", value: "db" },
    ];
    expect(
      bindingsForRoles(v, ["ingest"]).some((x) => x.binding.name === "DB"),
    ).toBe(true);
    expect(
      bindingsForRoles(v, ["cron"]).some((x) => x.binding.name === "DB"),
    ).toBe(false);
    v.blob.infra.bindings = [
      { name: "DB", kind: "env", purpose: "primary", value: "blob" },
    ];
    expect(
      validateStack(v).some((x) => x.message.includes("Duplicate binding")),
    ).toBe(true);
  });
  it("validates typed platform bindings and resource purposes", () => {
    const v = stack();
    v.store.infra.bindings = [
      { name: "R2", kind: "platform", purpose: "missing", value: "bucket" },
    ];
    expect(
      validateStack(v).some((x) => x.message.includes("requires a type")),
    ).toBe(true);
    expect(
      validateStack(v).some((x) =>
        x.message.includes("Unknown binding purpose"),
      ),
    ).toBe(true);
  });
  it("requires secret bindings to use sensitive or runtime references", () => {
    const v = stack();
    v.store.infra.bindings = [
      {
        name: "SECRET",
        kind: "secret",
        purpose: "primary",
        value: "plaintext",
      },
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
      purpose: "primary",
      value: variable("PUBLIC"),
    };
    expect(
      validateStack(v).some((x) => x.message.includes("must be sensitive")),
    ).toBe(true);
  });
  it("requires secret output references to be declared as such", () => {
    const v = stack();
    v.store.infra.bindings = [
      { name: "SECRET", kind: "secret", purpose: "primary", value: out("arn") },
    ];
    expect(validateStack(v).some((x) => x.message.includes("secret-ref"))).toBe(
      true,
    );
    v.store.infra.module.outputs.secret_id = "secret-ref";
    v.store.infra.bindings[0] = {
      name: "SECRET",
      kind: "secret",
      purpose: "primary",
      value: out("secret_id"),
    };
    expect(validateStack(v)).toEqual([]);
  });
  it("validates required capabilities and derives policies for each physical function", () => {
    const v = stack();
    delete v.store.infra.capabilities.read;
    expect(
      validateStack(v).some((x) =>
        x.message.includes("Role ingest requires store capability read"),
      ),
    ).toBe(true);
    v.store.infra.capabilities.read = "policy";
    const access = deriveAccess(v);
    expect(access.grants).toContainEqual({
      functionId: "ingest",
      selection: "store",
      capability: "read",
      purpose: "primary",
      policyOutput: "policy",
    });
    expect(
      access.grants.some(
        (x) =>
          x.functionId === "ingest" &&
          x.selection === "store" &&
          x.capability === "write",
      ),
    ).toBe(false);
  });
  it("scopes archive staging and erasure access only when archive is selected", () => {
    const v = stack();
    v.blob.infra.bindings = [
      { name: "DATA", kind: "env", purpose: "primary", value: "data" },
      { name: "STAGING", kind: "env", purpose: "staging", value: "stage" },
    ];
    expect(bindingsForRoles(v, ["cron"])).toEqual([]);
    v.archive = selection("archive");
    v.archive.manifest.capabilities = { rowDelete: "copy-on-write" };
    const access = deriveAccess(v);
    for (const capability of ["write", "list"]) {
      expect(access.grants).toContainEqual({
        functionId: "cron",
        selection: "blob",
        capability,
        purpose: "staging",
        policyOutput: "policy",
      });
    }
    expect(access.grants).toContainEqual({
      functionId: "consumer",
      selection: "blob",
      capability: "write",
      purpose: "staging",
      policyOutput: "policy",
    });
    expect(
      bindingsForRoles(v, ["cron"]).some(
        (item) => item.binding.name === "STAGING",
      ),
    ).toBe(true);
    expect(
      bindingsForRoles(v, ["ingest"]).some(
        (item) => item.binding.name === "STAGING",
      ),
    ).toBe(false);
    delete v.blob.infra.capabilities.list;
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Role cron requires blob capability list"),
      ),
    ).toBe(true);
  });
  it("merges shared-function grants and requires an IAM policy when appropriate", () => {
    const v = stack();
    (v.platform.config as { split: string[] }).split = [];
    const grants = deriveAccess(v).grants.filter(
      (item) => item.selection === "store" && item.capability === "read",
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]?.functionId).toBe("shared");
    v.store.infra.capabilities.read = null;
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes(
          "Role ingest requires store capability read with an IAM policy",
        ),
      ),
    ).toBe(true);
  });
  it("requires topic coverage and the core-owned consumer role", () => {
    const v = stack();
    delete (
      topics(v).routes as Partial<
        typeof v.queue.infra.topics extends never
          ? never
          : Record<string, unknown>
      >
    ).ingest;
    expect(
      validateStack(v).some((x) => x.message.includes("Missing topic")),
    ).toBe(true);
    const x = stack();
    (x.platform.config as { roles: string[] }).roles = [
      "ingest",
      "api",
      "cron",
    ];
    expect(
      validateStack(x).some((i) =>
        i.message.includes("does not deploy consumer"),
      ),
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
  it("requires queue capabilities from the core topic routes", () => {
    const v = stack();
    delete topics(v).routes.ingest.producerBinding;
    expect(
      validateStack(v).some((i) =>
        i.message.includes("Missing producer binding"),
      ),
    ).toBe(true);
    topics(v).routes.ingest.producerBinding = "QUEUE_URL";
    delete v.queue.infra.capabilities.produce;
    expect(
      validateStack(v).some((i) =>
        i.message.includes("Role ingest requires queue capability produce"),
      ),
    ).toBe(true);
    v.queue.infra.capabilities.produce = "policy";
    delete v.queue.infra.capabilities.consume;
    expect(
      validateStack(v).some((i) =>
        i.message.includes("Role consumer requires queue capability consume"),
      ),
    ).toBe(true);
  });
  it("requires a declared resource for each queue route", () => {
    const v = stack();
    delete v.queue.infra.resources.shared;
    expect(
      validateStack(v).some((i) =>
        i.message.includes("Unknown queue resource"),
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
    n.queue.infra.resources = {
      one: out("arn"),
      two: out("arn"),
      three: out("arn"),
    };
    for (const route of Object.values(topics(n).routes))
      delete route.producerBinding;
    topics(n).routes.ingest.producerBinding = "ONE";
    topics(n).routes.notifications.producerBinding = "THREE";
    n.queue.infra.bindings = [
      {
        name: "ONE",
        kind: "env",
        purpose: "one",
        capabilities: ["produce"],
        value: out("arn"),
      },
      {
        name: "THREE",
        kind: "env",
        purpose: "three",
        capabilities: ["produce"],
        value: out("arn"),
      },
    ];
    expect(validateStack(n)).toEqual([]);
  });
  it("does not give a queue producer binding to a role that only consumes that queue", () => {
    const v = stack();
    topics(v).mode = "per-topic";
    topics(v).routes.ingest = { physical: "events", producerBinding: "EVENTS" };
    topics(v).routes["archive.project"] = { physical: "archive" };
    topics(v).routes.notifications = {
      physical: "notifications",
      producerBinding: "NOTIFICATIONS",
    };
    v.queue.infra.resources = {
      events: out("arn"),
      archive: out("arn"),
      notifications: out("arn"),
    };
    v.queue.infra.bindings = [
      {
        name: "EVENTS",
        kind: "env",
        purpose: "events",
        capabilities: ["produce"],
        value: out("arn"),
      },
      {
        name: "NOTIFICATIONS",
        kind: "env",
        purpose: "notifications",
        capabilities: ["produce"],
        value: out("arn"),
      },
    ];
    expect(
      bindingsForRoles(v, ["ingest"]).some(
        (item) => item.binding.name === "EVENTS",
      ),
    ).toBe(true);
    expect(
      bindingsForRoles(v, ["consumer"]).some(
        (item) => item.binding.name === "EVENTS",
      ),
    ).toBe(false);
    v.queue.infra.bindings[0] = {
      name: "EVENTS",
      kind: "env",
      purpose: "events",
      capabilities: ["consume"],
      value: out("arn"),
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Producer binding does not support"),
      ),
    ).toBe(true);
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
        topics: ["ingest", "notifications"],
      },
      { kind: "cron", name: "retention", schedule: "15 * * * *", role: "cron" },
    ]);
    v.archive = selection("archive");
    v.archive.manifest.capabilities = { rowDelete: "copy-on-write" };
    expect(deriveTriggers(v)[0]).toMatchObject({
      topics: ["ingest", "archive.project", "notifications"],
    });
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
      physicalFunctions({ roles: [...roles], split: ["ingest"], cron: [] }),
    ).toEqual([
      { id: "ingest", roles: ["ingest"], settings: {} },
      { id: "shared", roles: ["api", "consumer", "cron"], settings: {} },
    ]);
    (v.platform.config as { split: string[] }).split = ["api", "api"];
    expect(validateStack(v).some((x) => x.message.includes("Duplicate"))).toBe(
      true,
    );
  });
  it("derives stable physical ids and merges compatible settings", () => {
    const a = {
      roles: [...roles],
      split: ["consumer", "ingest"] as (typeof roles)[number][],
      cron: [],
      settings: { api: { memoryMb: 512 }, cron: { timeoutSec: 30 } },
    };
    const b = {
      ...a,
      roles: [...a.roles].reverse(),
      split: [...a.split].reverse(),
    };
    expect(physicalFunctions(a)).toEqual(physicalFunctions(b));
    expect(physicalFunctions(a)).toEqual([
      { id: "ingest", roles: ["ingest"], settings: {} },
      { id: "consumer", roles: ["consumer"], settings: {} },
      {
        id: "shared",
        roles: ["api", "cron"],
        settings: { memoryMb: 512, timeoutSec: 30 },
      },
    ]);
    const v = stack();
    v.platform.config = {
      roles: [...roles],
      split: [],
      cron: [],
      settings: { ingest: { memoryMb: 128 }, api: { memoryMb: 1024 } },
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Conflicting memoryMb"),
      ),
    ).toBe(true);
  });
  it("rejects out-of-range common function settings", () => {
    for (const settings of [
      { memoryMb: 1 },
      { memoryMb: 1048577 },
      { timeoutSec: 0 },
      { timeoutSec: 100000 },
    ]) {
      const v = stack();
      v.platform.config = {
        roles: [...roles],
        split: [],
        cron: [],
        settings: { consumer: settings },
      };
      expect(
        validateStack(v).some((issue) => issue.path === "platform.config"),
      ).toBe(true);
    }
  });
  it("enforces platform authorization, supported binding kinds and reserved names", () => {
    const v = stack();
    v.platform.manifest.authorization = "bindings";
    v.platform.manifest.bindingKinds = ["platform"];
    v.queue.infra.bindings = [
      {
        name: "QUEUE",
        kind: "platform",
        platformType: "queue",
        purpose: "shared",
        value: out("arn"),
      },
    ];
    v.queue.infra.capabilities = { produce: null, consume: null };
    for (const route of Object.values(topics(v).routes))
      route.producerBinding = "QUEUE";
    expect(validateStack(v)).toEqual([]);
    v.platform.manifest.bindingKinds = ["env"];
    expect(
      validateStack(v).some((i) =>
        i.message.includes("does not support platform"),
      ),
    ).toBe(true);
    v.platform.manifest.bindingKinds = ["platform"];
    v.platform.manifest.reservedBindings = ["QUEUE", "AWS_LAMBDA_*"];
    expect(
      validateStack(v).some((i) =>
        i.message.includes("Reserved binding name QUEUE"),
      ),
    ).toBe(true);
    const binding = v.queue.infra.bindings[0];
    if (!binding) throw new Error("Missing queue binding");
    binding.name = "AWS_LAMBDA_CUSTOM";
    expect(
      validateStack(v).some((i) =>
        i.message.includes("Reserved binding name AWS_LAMBDA_CUSTOM"),
      ),
    ).toBe(true);
    v.platform.manifest.authorization = "iam";
    expect(
      validateStack(v).some((i) => i.message.includes("with an IAM policy")),
    ).toBe(true);
    v.platform.manifest.authorization = "none";
    expect(
      validateStack(v).some((i) =>
        i.message.includes("single long-lived process"),
      ),
    ).toBe(true);
  });
  it("accepts only scalar strings in environment bindings", () => {
    const v = stack();
    v.store.infra.module.outputs.list = "string[]";
    v.store.infra.module.outputs.json = "json";
    for (const value of [
      out("list"),
      out("json"),
      ["x"],
      { nested: "x" },
      2,
      env("PORT", { valueType: "number" }),
    ]) {
      v.store.infra.bindings = [
        { name: "VALUE", kind: "env", purpose: "primary", value },
      ];
      expect(
        validateStack(v).some((i) => i.message.includes("scalar string")),
      ).toBe(true);
    }
    v.store.infra.bindings = [
      { name: "VALUE", kind: "env", purpose: "primary", value: out("arn") },
    ];
    expect(validateStack(v)).toEqual([]);
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
