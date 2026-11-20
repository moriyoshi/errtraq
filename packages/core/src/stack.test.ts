import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AdapterSelection,
  artifact,
  bindingsForRoles,
  configReference,
  constructionOrder,
  defineStack,
  deriveAccess,
  deriveDeployment,
  deriveTriggers,
  env,
  escapeTerraformLiteral,
  generationEnv,
  isArtifactRef,
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
  terraformLiteral,
  terraformVariableType,
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
          ? {
              delivery: "push",
              maxBytes: 100,
              delay: true,
              dlq: false,
              visibilityTimeout: true,
            }
          : {},
  },
  config: {},
  runtimeModule: `@test/${kind}`,
  infra: {
    module: {
      provider: kind === "queue" ? "local" : "aws",
      component: kind,
      outputs: { arn: "string", policy: "json-document" },
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
        ? {
            produce: { shared: out("policy") },
            consume: { shared: out("policy") },
          }
        : kind === "store"
          ? {
              read: { primary: out("policy") },
              write: { primary: out("policy") },
              delete: { primary: out("policy") },
            }
          : kind === "blob"
            ? Object.fromEntries(
                ["read", "write", "delete", "list"].map((capability) => [
                  capability,
                  { primary: out("policy"), staging: out("policy") },
                ]),
              )
            : kind === "kv"
              ? {
                  read: { primary: out("policy") },
                  write: { primary: out("policy") },
                }
              : kind === "archive"
                ? {
                    read: { primary: out("policy") },
                    write: { primary: out("policy") },
                    delete: { primary: out("policy") },
                  }
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
          })
          .passthrough(),
      },
      config: { roles: [...roles], split: [...roles] },
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
function keyedQueue(mode: "shared" | "per-topic"): StackConfig {
  const v = stack();
  v.features = { notifications: true };
  v.archive = selection("archive");
  v.archive.manifest.capabilities = { rowDelete: "copy-on-write" };
  const keys =
    mode === "shared" ? ["shared"] : ["events", "archive", "notifications"];
  const physical = mode === "shared" ? ["shared", "shared", "shared"] : keys;
  const [events, archive, notifications] = physical;
  if (!events || !archive || !notifications) throw new Error("Invalid fixture");
  v.queue.infra.module.outputs = {
    queues: { map: { map: "string" } },
    policies: { map: { map: "json-document" } },
    unused: "string",
  };
  v.queue.infra.resources = Object.fromEntries(
    keys.map((key) => [key, out("queues", key, "arn")]),
  );
  v.queue.infra.capabilities = {
    produce: Object.fromEntries(
      keys.map((key) => [key, out("policies", "produce", key)]),
    ),
    consume: Object.fromEntries(
      keys.map((key) => [key, out("policies", "consume", key)]),
    ),
  };
  v.queue.infra.bindings = keys.map((key) => ({
    name: `Q_${key.toUpperCase()}`,
    kind: "env",
    purpose: key,
    capabilities: ["produce"],
    value: out("queues", key, "url"),
  }));
  v.queue.infra.topics = {
    mode,
    routes: {
      ingest: {
        physical: events,
        producerBinding: `Q_${events.toUpperCase()}`,
      },
      "archive.project": {
        physical: archive,
        producerBinding: `Q_${archive.toUpperCase()}`,
      },
      notifications: {
        physical: notifications,
        producerBinding: `Q_${notifications.toUpperCase()}`,
      },
    },
  };
  return v;
}
describe("infrastructure model", () => {
  it("checks declared child kinds and detects colliding Terraform module names", () => {
    const v = stack();
    v.kv.manifest.childKinds = { wrong: "kv", a_b: "kv", a: "kv" };
    const wrong = selection("kv");
    wrong.manifest = v.platform.manifest;
    const a = selection("kv");
    a.manifest.childKinds = { b: "kv" };
    a.children = { b: selection("kv") };
    v.kv.children = { wrong, a_b: selection("kv"), a };
    const issues = validateStack(v);
    expect(
      issues.some((issue) =>
        issue.message.includes("Expected kv child adapter, got platform"),
      ),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.message.includes("Module name kv_a_b collides"),
      ),
    ).toBe(true);
    delete v.kv.manifest.childKinds.wrong;
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Child kind is not declared"),
      ),
    ).toBe(true);
  });
  it("retains literal Terraform template syntax and identifies the required escaping", () => {
    const literal = ["prefix $", "{var.value} and %{if condition}"].join("");
    expect(terraformLiteral(literal)).toEqual({
      value: literal,
      needsEscaping: true,
    });
    expect(escapeTerraformLiteral(literal)).toBe(
      "prefix $${var.value} and %%{if condition}",
    );
    expect(terraformLiteral("plain")).toEqual({
      value: "plain",
      needsEscaping: false,
    });
    const v = stack();
    v.store.infra.inputs = () => ({ literal });
    expect(validateStack(v)).toEqual([]);
  });
  it("requires native JSON objects or arrays for existing JSON outputs", () => {
    expect(terraformVariableType("json")).toBe("string");
    expect(terraformVariableType("string[]")).toBe("list(string)");
    const v = stack();
    v.blob.infra.module.outputs.document = "json";
    v.blob.existing = {
      arn: "bucket",
      policy: "{}",
      document: { Statement: [] },
    };
    expect(validateStack(v)).toEqual([]);
    v.blob.existing.document = '{"Statement":[]}';
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Expected json output value"),
      ),
    ).toBe(true);
    v.variables = {
      DOCUMENT: { type: "json", sensitive: false },
      TEXT: { type: "string", sensitive: false },
    };
    v.blob.existing.document = variable("DOCUMENT");
    expect(validateStack(v)).toEqual([]);
    v.blob.existing.document = variable("TEXT");
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Expected json output value"),
      ),
    ).toBe(true);
  });
  it("requires encoded JSON policy outputs and validates existing JSON text", () => {
    const v = stack();
    v.blob.existing = {
      arn: "bucket",
      policy: '{"Version":"2012-10-17","Statement":[]}',
    };
    expect(validateStack(v)).toEqual([]);
    v.blob.existing.policy = "not-json";
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Expected json-document"),
      ),
    ).toBe(true);
    v.blob.infra.module.outputs.policy = "string";
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("JSON policy document"),
      ),
    ).toBe(true);
    v.blob.infra.module.outputs.policy = "json";
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("JSON policy document"),
      ),
    ).toBe(true);
  });
  it("rejects unsafe infrastructure keys and provider tags", () => {
    const v = stack();
    const dangerous = ["$", "{var.attacker}"].join("");
    v.store.infra.inputs = () => ({ nested: { [dangerous]: "value" } });
    if (v.providers?.aws) v.providers.aws.tags = { [dangerous]: "value" };
    const issues = validateStack(v);
    expect(
      issues.some(
        (issue) =>
          issue.path.startsWith("store.infra.inputs") &&
          issue.message.includes("Unsafe"),
      ),
    ).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.path.startsWith("providers.aws.tags") &&
          issue.message.includes("Unsafe"),
      ),
    ).toBe(true);
    expect(escapeTerraformLiteral(dangerous)).toBe("$${var.attacker}");
    expect(escapeTerraformLiteral("%{if enabled}")).toBe("%%{if enabled}");
  });
  it("checks AWS provider region by source and resolves selection aliases", () => {
    const v = stack();
    v.providers = {
      ...v.providers,
      aws_eu: { source: "hashicorp/aws", version: "~> 6.0" },
    };
    v.store.provider = "aws_eu";
    v.store.infra.inputs = () => ({ region: stackValue("region") });
    expect(
      validateStack(v).some(
        (issue) => issue.path === "providers.aws_eu.region",
      ),
    ).toBe(true);
    if (v.providers.aws_eu) v.providers.aws_eu.region = "eu-west-1";
    expect(validateStack(v)).toEqual([]);
    if (v.providers.aws_eu) v.providers.aws_eu.source = "other/cloudflare";
    expect(
      validateStack(v).some((issue) => issue.path === "store.provider"),
    ).toBe(true);
  });
  it("rejects a spread copy of a resolved stack without re-parsing it", () => {
    const v = stack();
    let count = 0;
    v.blob.manifest.configSchema = z.object({}).transform(() => {
      count++;
      return { transformed: true };
    });
    const resolved = resolveStack(v);
    expect(count).toBe(1);
    const copy = { ...resolved };
    expect(validateStack(copy)[0]?.message).toContain("resolved stack copy");
    expect(() => resolveStack(copy)).toThrow("resolved stack copy");
    expect(count).toBe(1);
  });
  it("rejects credentials and unknown backends in backend configuration", () => {
    const v = stack();
    v.backend = {
      type: "s3",
      config: { bucket: "bucket", key: "state", secret_key: "literal-secret" },
    };
    expect(
      validateStack(v).some(
        (issue) => issue.path === "backend.config.secret_key",
      ),
    ).toBe(true);
    v.backend.config = {
      bucket: generationEnv("AWS_SECRET_ACCESS_KEY"),
      key: "state",
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("credential environment"),
      ),
    ).toBe(true);
    v.backend.type = "custom";
    expect(
      validateStack(v).some((issue) => issue.path === "backend.type"),
    ).toBe(true);
  });
  it("keeps shared and split role identifiers stable across split changes", () => {
    const a = physicalFunctions({ roles: [...roles], split: ["ingest"] });
    const b = physicalFunctions({
      roles: [...roles],
      split: ["ingest", "cron"],
    });
    expect(a.map((fn) => fn.id)).toEqual(["ingest", "shared"]);
    expect(b.map((fn) => fn.id)).toEqual(["ingest", "cron", "shared"]);
  });
  it("activates notifications only when explicitly enabled", () => {
    const v = stack();
    expect(deriveTriggers(v)[0]).toMatchObject({ topics: ["ingest"] });
    expect(
      deriveAccess(v).grants.some(
        (g) => g.functionId === "consumer" && g.capability === "produce",
      ),
    ).toBe(false);
    v.features = { notifications: true };
    expect(deriveTriggers(v)[0]).toMatchObject({
      topics: ["ingest", "notifications"],
    });
    expect(
      deriveAccess(v).grants.some(
        (g) => g.functionId === "consumer" && g.capability === "produce",
      ),
    ).toBe(true);
  });
  it("reports excessive nesting in config, selections, and computed inputs", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 50000; i++) deep = [deep];
    const config = stack();
    config.store.config = deep;
    expect(
      validateStack(config).some((issue) =>
        issue.message.includes("maximum nesting depth"),
      ),
    ).toBe(true);
    const computed = stack();
    computed.store.infra.inputs = () => ({ deep: deep as never });
    expect(
      validateStack(computed).some((issue) =>
        issue.message.includes("maximum nesting depth"),
      ),
    ).toBe(true);
    let child = selection("kv");
    for (let i = 0; i < 5000; i++)
      child = { ...selection("kv"), children: { nested: child } };
    const nested = stack();
    nested.kv.children = { nested: child };
    expect(
      validateStack(nested).some((issue) =>
        issue.message.includes("maximum nesting depth"),
      ),
    ).toBe(true);
  });
  it("passes the derived deployment view to platform inputs", () => {
    const v = keyedQueue("shared");
    v.platform.config = {
      roles: [...roles],
      split: [...roles],
      http: ["ingest", "api"],
      settings: { consumer: { timeoutSec: 30 } },
    };
    v.queue.manifest.capabilities.dlq = true;
    topics(v).settings = {
      shared: {
        batchSize: 10,
        maxConcurrency: 3,
        visibilityTimeoutSec: 180,
        dlq: { enabled: true, maxReceiveCount: 4 },
      },
    };
    v.store.infra.module.outputs.secret = "secret-ref";
    v.store.infra.bindings = [
      { name: "DB", kind: "env", purpose: "primary", value: out("arn") },
      {
        name: "SECRET",
        kind: "secret",
        purpose: "primary",
        value: out("secret"),
      },
    ];
    let observed: ReturnType<typeof deriveDeployment> | undefined;
    v.platform.infra.inputs = (_config, view) => {
      observed = view;
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.isFrozen(view.functions)).toBe(true);
      const ingest = view.functions.find((fn) => fn.id === "ingest");
      if (!ingest) throw new Error("Missing ingest function");
      return { artifact: ingest.artifact };
    };
    const resolved = resolveStack(v);
    const view = deriveDeployment(resolved);
    expect(observed).toEqual(view);
    const ingest = view.functions.find((fn) => fn.id === "ingest");
    expect(ingest?.http).toEqual(["ingest"]);
    expect(isArtifactRef(ingest?.artifact)).toBe(true);
    expect(ingest?.envBindings.some((item) => item.binding.name === "DB")).toBe(
      true,
    );
    expect(
      ingest?.envBindings.find((item) => item.binding.name === "DB")?.binding
        .value,
    ).toEqual(output("store", "arn"));
    expect(
      ingest?.secretBindings.some((item) => item.binding.name === "SECRET"),
    ).toBe(true);
    expect(
      ingest?.secretReads.some((item) => item.bindingName === "SECRET"),
    ).toBe(true);
    expect(
      ingest?.policies.some(
        (grant) => grant.policyOutput?.selection === "store",
      ),
    ).toBe(true);
    expect(
      view.triggers.find((trigger) => trigger.kind === "queue"),
    ).toMatchObject({
      functionId: "consumer",
      resource: output("queue", "queues", "shared", "arn"),
      settings: { batchSize: 10, maxConcurrency: 3, visibilityTimeoutSec: 180 },
    });
    expect(
      view.triggers.filter((trigger) => trigger.kind === "cron"),
    ).toHaveLength(3);
    expect(
      view.triggers
        .filter((trigger) => trigger.kind === "cron")
        .every((trigger) => trigger.functionId === "cron"),
    ).toBe(true);
  });
  it("validates HTTP exposure and deployed stack output references", () => {
    const v = stack();
    v.platform.config = {
      roles: [...roles],
      split: [...roles],
      http: ["ingest", "api"],
    };
    v.outputs = { ingest_url: output("platform", "arn") };
    expect(validateStack(v)).toEqual([]);
    v.platform.existing = {};
    expect(
      validateStack(v).some(
        (issue) =>
          issue.path === "outputs.ingest_url" &&
          issue.message.includes("Missing existing output"),
      ),
    ).toBe(true);
    delete v.platform.existing;
    v.outputs.ingest_url = output("platform", "missing");
    expect(
      validateStack(v).some(
        (issue) =>
          issue.path === "outputs.ingest_url" &&
          issue.message.includes("Unknown output"),
      ),
    ).toBe(true);
    v.outputs.ingest_url = output("platform", "arn");
    v.platform.config = {
      roles: ["ingest", "consumer", "cron"],
      split: ["ingest", "consumer", "cron"],
      http: ["api", "consumer"],
    };
    const issues = validateStack(v);
    expect(
      issues.some((issue) => issue.message.includes("does not deploy api")),
    ).toBe(true);
    expect(
      issues.some((issue) =>
        issue.message.includes("consumer has no HTTP app"),
      ),
    ).toBe(true);
    v.platform.config = {
      roles: [...roles],
      split: [],
      http: ["ingest", "ingest"],
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Duplicate HTTP"),
      ),
    ).toBe(true);
  });
  it("restricts build artifact references to deployed platform inputs", () => {
    const v = stack();
    v.platform.infra.inputs = () => ({ bundle: artifact("missing") });
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Unknown artifact function missing"),
      ),
    ).toBe(true);
    v.platform.infra.inputs = () => ({});
    v.store.infra.inputs = () => ({ bundle: artifact("ingest") });
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("only valid in platform module inputs"),
      ),
    ).toBe(true);
  });
  it("enforces queue visibility, trigger limits and DLQ support", () => {
    const v = stack();
    v.platform.config = {
      roles: [...roles],
      split: [...roles],
      settings: { consumer: { timeoutSec: 30 } },
    };
    v.queue.manifest.capabilities.dlq = true;
    topics(v).settings = {
      shared: {
        visibilityTimeoutSec: 180,
        batchSize: 1,
        maxConcurrency: 1,
        dlq: { enabled: true, maxReceiveCount: 3 },
      },
    };
    expect(validateStack(v)).toEqual([]);
    topics(v).settings = {};
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Queue visibility is required"),
      ),
    ).toBe(true);
    topics(v).settings = { shared: { visibilityTimeoutSec: 179 } };
    expect(
      validateStack(v).some((issue) => issue.message.includes("six times")),
    ).toBe(true);
    v.platform.config = { roles: [...roles], split: [...roles] };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Consumer timeout is required"),
      ),
    ).toBe(true);
    topics(v).settings = { shared: { batchSize: 0 } };
    expect(validateStack(v).length).toBeGreaterThan(0);
    topics(v).settings = { shared: { maxConcurrency: 0 } };
    expect(validateStack(v).length).toBeGreaterThan(0);
    topics(v).settings = { shared: { dlq: { enabled: true } } };
    v.queue.manifest.capabilities.dlq = false;
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("does not support a DLQ"),
      ),
    ).toBe(true);
    topics(v).settings = { missing: { batchSize: 1 } };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Unknown physical queue"),
      ),
    ).toBe(true);
  });
  it("requires visibility timing only for queues that support it", () => {
    const v = stack();
    v.platform.config = {
      roles: [...roles],
      split: [...roles],
      settings: { consumer: { timeoutSec: 30 } },
    };
    v.queue.manifest.capabilities.visibilityTimeout = false;
    expect(validateStack(v)).toEqual([]);
    topics(v).settings = { shared: { visibilityTimeoutSec: 180 } };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("does not support visibility timeouts"),
      ),
    ).toBe(true);
  });
  it("preserves platform-owned per-function settings accepted by a Workers schema", () => {
    const v = stack();
    for (const selection of selections(v).values())
      selection.manifest.runtimes = ["workers"];
    v.platform.manifest.runtime = "workers";
    v.platform.manifest.configSchema = z.object({
      roles: z.array(z.enum(roles)),
      split: z.array(z.enum(roles)),
      settings: z.partialRecord(
        z.enum(roles),
        z.object({ cpuMs: z.number().int().positive() }),
      ),
    });
    v.platform.config = {
      roles: [...roles],
      split: [...roles],
      settings: { consumer: { cpuMs: 50 } },
    };
    expect(validateStack(v)).toEqual([]);
    expect(
      deriveDeployment(v).functions.find((fn) => fn.id === "consumer")?.settings
        .cpuMs,
    ).toBe(50);
    v.platform.config = {
      roles: [...roles],
      split: [...roles],
      settings: { consumer: { cpuMs: "invalid" } },
    };
    expect(
      validateStack(v).some((issue) =>
        issue.path.includes("platform.config.settings"),
      ),
    ).toBe(true);
  });
  it("derives per-resource queue policies and triggers in per-topic and shared modes", () => {
    const v = keyedQueue("per-topic");
    expect(validateStack(v)).toEqual([]);
    expect(deriveTriggers(v).filter((t) => t.kind === "queue")).toHaveLength(3);
    const grants = deriveAccess(v).grants.filter(
      (g) => g.selection === "queue",
    );
    expect(
      grants.filter(
        (g) => g.functionId === "ingest" && g.capability === "produce",
      ),
    ).toEqual([
      {
        functionId: "ingest",
        selection: "queue",
        capability: "produce",
        purpose: "events",
        policyOutput: out("policies", "produce", "events"),
      },
    ]);
    expect(
      grants
        .filter(
          (g) => g.functionId === "consumer" && g.capability === "consume",
        )
        .map((g) => g.policyOutput),
    ).toEqual([
      out("policies", "consume", "events"),
      out("policies", "consume", "archive"),
      out("policies", "consume", "notifications"),
    ]);
    const shared = keyedQueue("shared");
    expect(validateStack(shared)).toEqual([]);
    expect(
      deriveTriggers(shared).filter((t) => t.kind === "queue"),
    ).toHaveLength(1);
  });
  it("uses the staging policy for cron staging writes, preserving primary erasure access", () => {
    const v = keyedQueue("shared");
    v.blob.infra.module.outputs.policies = { map: { map: "json-document" } };
    for (const [capability, policies] of Object.entries(
      v.blob.infra.capabilities,
    )) {
      policies.primary = out("policies", capability, "primary");
      policies.staging = out("policies", capability, "staging");
    }
    const grants = deriveAccess(v).grants.filter(
      (g) => g.selection === "blob" && g.functionId === "cron",
    );
    expect(
      grants.filter((g) => g.capability === "write").map((g) => g.policyOutput),
    ).toEqual([out("policies", "write", "staging")]);
    expect(
      grants.some(
        (g) =>
          g.capability === "delete" &&
          g.purpose === "primary" &&
          JSON.stringify(g.policyOutput?.path) ===
            JSON.stringify(["delete", "primary"]),
      ),
    ).toBe(true);
  });
  it("requires only reachable existing outputs and map keys, naming the requesting role", () => {
    const v = keyedQueue("per-topic");
    v.queue.existing = {
      queues: {
        events: { arn: "a", url: "a" },
        archive: { arn: "b", url: "b" },
        notifications: { arn: "c", url: "c" },
      },
      policies: {
        produce: { events: "{}", archive: "{}", notifications: "{}" },
        consume: { events: "{}", archive: "{}", notifications: "{}" },
      },
    };
    expect(validateStack(v)).toEqual([]);
    const completeQueues = v.queue.existing.queues;
    v.queue.existing.queues = {
      events: { arn: "a" },
      archive: { arn: "b", url: "b" },
      notifications: { arn: "c", url: "c" },
    };
    expect(
      validateStack(v).some(
        (issue) =>
          issue.message.includes("queue.queues.events.url") &&
          issue.message.includes("function ingest"),
      ),
    ).toBe(true);
    v.queue.existing.queues = completeQueues;
    v.queue.existing.policies = {
      produce: { archive: "{}", notifications: "{}" },
      consume: { events: "{}", archive: "{}", notifications: "{}" },
    };
    expect(
      validateStack(v).some(
        (issue) =>
          issue.message.includes("queue.policies.produce.events") &&
          issue.message.includes("role ingest"),
      ),
    ).toBe(true);
  });
  it("rejects invalid output key paths and non-identifier physical keys", () => {
    const v = keyedQueue("per-topic");
    v.queue.infra.resources.events = out("queues", "events", "arn", "extra");
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Invalid key path"),
      ),
    ).toBe(true);
    v.queue.infra.resources.events = out("queues", "archive.project", "arn");
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Invalid reference"),
      ),
    ).toBe(true);
    topics(v).routes.ingest.physical = "archive.project";
    expect(
      validateStack(v).some((issue) => issue.path.includes("physical")),
    ).toBe(true);
  });
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
    v.variables = {
      ...v.variables,
      PUBLIC: { type: "string", sensitive: false },
    };
    v.store.config = { path: variable("PUBLIC") };
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
      secret: variable("SECRET"),
    });
    v.store.infra.module.sensitiveInputs = ["secret"];
    v.store.infra.bindings = [
      {
        name: "TOKEN",
        kind: "secret",
        purpose: "primary",
        value: variable("IDENTIFIER"),
      },
    ];
    v.variables = {
      ...v.variables,
      IDENTIFIER: { type: "string", sensitive: false },
    };
    expect(validateStack(v)).toEqual([]);
    expect(resolveStack(v).store.config).toEqual({ enabled: true });
    expect(defineStack(v).store.infra.bindings[0]?.value).toEqual(
      variable("IDENTIFIER"),
    );
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
  it("substitutes reachable existing outputs", () => {
    const v = stack();
    v.blob.existing = { arn: "external" };
    v.store.infra.inputs = () => ({ bucket: output("blob", "arn") });
    expect(
      validateStack(v).some((x) =>
        x.message.includes("Missing existing output blob.policy"),
      ),
    ).toBe(true);
    v.blob.existing.policy = "{}";
    expect(validateStack(v)).toEqual([]);
    v.blob.existing.arn = out("arn");
    expect(validateStack(v).some((x) => x.message.includes("own output"))).toBe(
      true,
    );
  });
  it("rejects unknown existing output names", () => {
    const v = stack();
    v.blob.existing = { arn: "a", policy: "{}", typo: "x" };
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
        x.message.includes(
          "Secret binding must reference a secret-store identifier",
        ),
      ),
    ).toBe(true);
    v.variables = { PUBLIC: { type: "string", sensitive: false } };
    v.store.infra.bindings[0] = {
      name: "SECRET",
      kind: "secret",
      purpose: "primary",
      value: variable("PUBLIC"),
    };
    expect(validateStack(v)).toEqual([]);
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
  it("derives secret-read requirements only for functions receiving identifiers", () => {
    const v = stack();
    v.variables = { ID: { type: "string", sensitive: false } };
    v.store.infra.bindings = [
      {
        name: "SECRET_ID",
        kind: "secret",
        purpose: "primary",
        capabilities: ["write"],
        value: variable("ID"),
      },
    ];
    const requirements = deriveAccess(v).secretReads;
    expect(requirements.map((r) => r.functionId).sort()).toEqual([
      "api",
      "consumer",
    ]);
    expect(requirements.every((r) => r.bindingName === "SECRET_ID")).toBe(true);
    expect(requirements[0]?.identifier).toEqual(variable("ID"));
    v.variables.ID = { type: "string", sensitive: true };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("non-sensitive string"),
      ),
    ).toBe(true);
    v.store.infra.bindings[0] = {
      name: "SECRET_ID",
      kind: "secret",
      purpose: "primary",
      value: env("SECRET"),
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("secret-store identifier"),
      ),
    ).toBe(true);
  });
  it("limits sensitive variables and generation environment references to their declared contexts", () => {
    const v = stack();
    v.store.infra.inputs = () => ({
      credentials: { token: variable("SECRET") },
    });
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Sensitive variables require"),
      ),
    ).toBe(true);
    v.store.infra.module.sensitiveInputs = ["credentials"];
    expect(validateStack(v)).toEqual([]);
    v.store.infra.inputs = () => ({ credentials: generationEnv("PASSWORD") });
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Generation environment references"),
      ),
    ).toBe(true);
    v.store.infra.inputs = () => ({});
    v.store.infra.bindings = [
      {
        name: "BAD",
        kind: "env",
        purpose: "primary",
        value: variable("SECRET"),
      },
    ];
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Sensitive variables require"),
      ),
    ).toBe(true);
    v.store.infra.bindings[0] = {
      name: "BAD",
      kind: "env",
      purpose: "primary",
      value: generationEnv("PASSWORD"),
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Generation environment references"),
      ),
    ).toBe(true);
    v.store.infra.bindings = [];
    v.backend = { type: "s3", config: { bucket: generationEnv("BUCKET") } };
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
    v.store.infra.capabilities.read = { primary: out("policy") };
    const access = deriveAccess(v);
    expect(access.grants).toContainEqual({
      functionId: "ingest",
      selection: "store",
      capability: "read",
      purpose: "primary",
      policyOutput: out("policy"),
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
        policyOutput: out("policy"),
      });
    }
    expect(access.grants).toContainEqual({
      functionId: "consumer",
      selection: "blob",
      capability: "write",
      purpose: "staging",
      policyOutput: out("policy"),
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
    v.store.infra.capabilities.read = { primary: null };
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
    v.queue.infra.capabilities.produce = { shared: out("policy") };
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
  it("rejects undefined or non-policy-typed capability outputs and self-output inputs", () => {
    const v = stack();
    v.store.infra.module.outputs.invalidPolicy = "string[]";
    v.store.infra.capabilities = { read: { primary: out("invalidPolicy") } };
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
    n.queue.infra.capabilities = {
      produce: { one: out("policy"), two: out("policy"), three: out("policy") },
      consume: { one: out("policy"), two: out("policy"), three: out("policy") },
    };
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
    v.queue.infra.capabilities = {
      produce: {
        events: out("policy"),
        archive: out("policy"),
        notifications: out("policy"),
      },
      consume: {
        events: out("policy"),
        archive: out("policy"),
        notifications: out("policy"),
      },
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
    expect(deriveTriggers(v)).toEqual([
      {
        kind: "queue",
        functionId: "consumer",
        physical: "shared",
        role: "consumer",
        resource: output("queue", "arn"),
        settings: {},
        topics: ["ingest"],
      },
    ]);
    v.archive = selection("archive");
    v.archive.manifest.capabilities = { rowDelete: "copy-on-write" };
    expect(deriveTriggers(v)[0]).toMatchObject({
      topics: ["ingest", "archive.project"],
    });
  });
  it("derives all core cron jobs when the archive and cron role are selected", () => {
    const v = stack();
    expect(
      deriveTriggers(v).filter((trigger) => trigger.kind === "cron"),
    ).toEqual([]);
    v.archive = selection("archive");
    v.archive.manifest.capabilities = { rowDelete: "copy-on-write" };
    expect(
      deriveTriggers(v).filter((trigger) => trigger.kind === "cron"),
    ).toHaveLength(3);
    (v.platform.config as { roles: string[] }).roles = [
      "ingest",
      "api",
      "consumer",
    ];
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("does not deploy cron"),
      ),
    ).toBe(true);
  });
  it("derives split groups and validates role settings", () => {
    const v = stack();
    expect(physicalFunctions({ roles: [...roles], split: ["ingest"] })).toEqual(
      [
        { id: "ingest", roles: ["ingest"], settings: {} },
        { id: "shared", roles: ["api", "consumer", "cron"], settings: {} },
      ],
    );
    (v.platform.config as { split: string[] }).split = ["api", "api"];
    expect(validateStack(v).some((x) => x.message.includes("Duplicate"))).toBe(
      true,
    );
  });
  it("derives stable physical ids and merges compatible settings", () => {
    const a = {
      roles: [...roles],
      split: ["consumer", "ingest"] as (typeof roles)[number][],

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
    v.queue.infra.capabilities = {
      produce: { shared: null },
      consume: { shared: null },
    };
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
    v.archive.manifest.childKinds = { catalog: "catalog", engine: "engine" };
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
  it("derives platform graph edges and constructs the platform last", () => {
    const v = stack();
    expect(constructionOrder(v).at(-1)).toBe("platform");
    v.queue.infra.inputs = () => ({ platform: output("platform", "arn") });
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("Module dependency cycle"),
      ),
    ).toBe(true);
  });
  it("does not interpret a child selection named existing as an existing-value context", () => {
    const v = stack();
    const child = selection("kv");
    child.infra.bindings = [
      { name: "CHILD", kind: "env", purpose: "primary", value: out("arn") },
    ];
    v.kv.manifest.childKinds = { existing: "kv" };
    v.kv.children = { existing: child };
    expect(validateStack(v)).toEqual([]);
  });
  it("rejects removed module versions and cron lists", () => {
    const v = stack();
    expect(
      validateStack({
        ...v,
        platform: {
          ...v.platform,
          config: { roles: [...roles], split: [], cron: [] },
        },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateStack({
        ...v,
        blob: {
          ...v.blob,
          infra: {
            ...v.blob.infra,
            module: { ...v.blob.infra.module, version: "1" },
          },
        },
      }).length,
    ).toBeGreaterThan(0);
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
