import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineStack,
  env,
  out,
  type PortKind,
  resolveStack,
  type StackConfig,
  validateStack,
} from "./index.js";

const selection = (
  kind: PortKind,
  capabilities: Record<string, string | boolean | number> = {},
) => ({
  manifest: {
    id: kind,
    kind,
    runtimes: ["worker"],
    capabilities,
    configSchema: z.object({ enabled: z.boolean() }),
  },
  infra: {
    module: `test/${kind}`,
    inputs: () => ({}),
    bindings: {},
    grants: [],
    triggers: [],
  },
  runtimeModule: `@test/${kind}`,
  config: { enabled: true },
});
const stack = (): StackConfig => ({
  name: "test",
  platform: {
    ...selection("platform"),
    manifest: {
      ...selection("platform").manifest,
      kind: "platform",
      runtime: "worker",
      compute: "function",
      functions: ["ingest", "api", "consumer", "cron"],
    },
  },
  store: selection("store", {
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
    deleteStrategy: "explicit",
  }),
  queue: selection("queue", {
    delivery: "push",
    maxBytes: 100,
    delay: false,
    dlq: false,
  }),
  blob: selection("blob"),
  kv: selection("kv"),
});
describe("stack validation", () => {
  it("accepts a compatible stack and preserves references", () => {
    const value = stack();
    expect(defineStack(value)).toEqual(value);
    expect(env("SECRET")).toEqual({ kind: "env", name: "SECRET" });
    expect(out("url")).toEqual({ kind: "output", name: "url" });
  });
  it("reports adapter schemas, kind, and runtime", () => {
    const value = stack();
    value.blob.config = { enabled: "yes" };
    value.store.manifest.kind = "blob";
    value.kv.manifest.runtimes = ["node"];
    expect(validateStack(value).map((x) => x.path)).toEqual(
      expect.arrayContaining(["blob.config.enabled", "store", "kv"]),
    );
  });
  it("rejects a pull-only queue on functions", () => {
    const value = stack();
    value.queue.manifest.capabilities.delivery = "pull";
    expect(() => defineStack(value)).toThrow(/Pull-only/);
    value.platform.manifest.compute = "long-lived";
    expect(validateStack(value)).toEqual([]);
  });
  it("enforces capability requirements, including absent adapters", () => {
    const value = stack();
    value.requirements = {
      store: { textSearch: true },
      archive: { rowDelete: "deletion-vector" },
    };
    expect(validateStack(value).map((x) => x.path)).toEqual([
      "store.capabilities.textSearch",
      "archive.capabilities.rowDelete",
    ]);
  });
  it("rejects malformed stacks", () => {
    expect(validateStack({ name: "" }).length).toBeGreaterThan(0);
  });
  it("requires infrastructure and an import specifier without importing runtime code", () => {
    const value = stack();
    value.queue.runtimeModule = "";
    expect(validateStack(value).map((x) => x.path)).toContain(
      "queue.runtimeModule",
    );
    const malformed = {
      ...stack(),
      blob: { ...stack().blob, infra: undefined },
    };
    expect(validateStack(malformed).map((x) => x.path)).toContain("blob.infra");
  });
  it("validates every grant and trigger against platform roles", () => {
    const value = stack();
    value.platform.manifest.functions = ["ingest"];
    value.queue.infra.grants.push({
      role: "producer",
      to: ["ingest", "consumer"],
    });
    value.queue.infra.triggers.push({
      fn: "cron",
      kind: "cron",
      source: "0 * * * *",
    });
    expect(validateStack(value).map((x) => x.path)).toEqual([
      "queue.infra.grants.0.to",
      "queue.infra.triggers.0.fn",
    ]);
    value.platform.manifest.functions.push("consumer", "cron");
    expect(validateStack(value)).toEqual([]);
  });
  it("requires existing bindings to match descriptor names exactly", () => {
    const value = stack();
    value.queue.infra.bindings = { URL: out("queue_url"), TOKEN: out("token") };
    value.queue.existing = { URL: env("QUEUE_URL"), EXTRA: "unexpected" };
    expect(validateStack(value).map((x) => x.path)).toEqual([
      "queue.existing.TOKEN",
      "queue.existing.EXTRA",
    ]);
    value.queue.existing = { URL: env("QUEUE_URL"), TOKEN: env("QUEUE_TOKEN") };
    expect(validateStack(value)).toEqual([]);
  });
  it("rejects unknown fields and unsafe names", () => {
    expect(validateStack({ ...stack(), archvie: {} }).length).toBeGreaterThan(
      0,
    );
    expect(
      validateStack({ ...stack(), name: "../bad" }).length,
    ).toBeGreaterThan(0);
  });
  it("rejects duplicated binding names", () => {
    const v = stack();
    v.store.infra.bindings = { SAME: out("a") };
    v.queue.infra.bindings = { SAME: out("b") };
    expect(validateStack(v).some((x) => x.path.includes("bindings.SAME"))).toBe(
      true,
    );
  });
  it("rejects malformed refs", () => {
    const v = stack();
    v.store.infra.bindings = { BAD: { kind: "outptu", name: 1 } };
    expect(validateStack(v).length).toBeGreaterThan(0);
  });
  it("requires valid per-kind capabilities", () => {
    const v = stack();
    v.queue.manifest.capabilities.delivery = "Pull";
    delete v.store.manifest.capabilities.deleteStrategy;
    expect(validateStack(v).map((x) => x.path)).toEqual(
      expect.arrayContaining([
        "queue.manifest.capabilities.delivery",
        "store.manifest.capabilities.deleteStrategy",
      ]),
    );
  });
  it("checks existing output refs and trigger sources", () => {
    const v = stack();
    v.queue.infra.bindings = { URL: out("url") };
    v.queue.existing = { URL: out("url") };
    v.queue.infra.triggers = [
      { fn: "cron", kind: "cron", source: out("url") },
      { fn: "consumer", kind: "queue", source: "" },
      { fn: "consumer", kind: "queue", source: out("missing") },
    ];
    expect(validateStack(v).length).toBeGreaterThanOrEqual(4);
  });
  it("reports asynchronous and throwing schemas", () => {
    const v = stack();
    v.store.manifest.configSchema = z
      .object({ enabled: z.boolean() })
      .refine(async () => true);
    expect(validateStack(v).some((x) => x.path === "store.config")).toBe(true);
    v.store.manifest.configSchema = z.any().transform(() => {
      throw new Error("boom");
    });
    expect(validateStack(v).some((x) => x.path === "store.config")).toBe(true);
  });
  it("uses parsed defaults in inputs and returns parsed config", () => {
    const v = stack();
    v.store.manifest.configSchema = z.object({
      n: z.coerce.number().default(7),
    });
    v.store.config = {};
    v.store.infra.inputs = (cfg) => ({ n: (cfg as { n: number }).n });
    expect(validateStack(v)).toEqual([]);
    expect(resolveStack(v).store.config).toEqual({ n: 7 });
    v.store.infra.inputs = () => ({ bad: undefined }) as never;
    expect(validateStack(v).some((x) => x.path === "store.infra.inputs")).toBe(
      true,
    );
  });
  it("rejects unknown nested fields and missing or invalid capability variants", () => {
    const v = stack();
    const broken = {
      ...v,
      queue: { ...v.queue, infra: { ...v.queue.infra, typo: true } },
    };
    expect(validateStack(broken).some((x) => x.path === "queue.infra")).toBe(
      true,
    );
    const q = stack();
    q.queue.manifest.capabilities = {
      delivery: "push",
      maxBytes: 0,
      delay: "yes",
      dlq: "no",
    };
    expect(validateStack(q).map((x) => x.path)).toEqual(
      expect.arrayContaining([
        "queue.manifest.capabilities.maxBytes",
        "queue.manifest.capabilities.delay",
        "queue.manifest.capabilities.dlq",
      ]),
    );
    const archive = stack();
    archive.archive = selection("archive", { rowDelete: "bad" });
    expect(
      validateStack(archive).some(
        (x) => x.path === "archive.manifest.capabilities.rowDelete",
      ),
    ).toBe(true);
  });
  it("allows an existing binding to replace a trigger output", () => {
    const v = stack();
    v.queue.infra.bindings = { URL: out("queue_url") };
    v.queue.existing = { URL: env("QUEUE_URL") };
    v.queue.infra.triggers.push({
      fn: "consumer",
      kind: "queue",
      source: out("queue_url"),
    });
    expect(validateStack(v)).toEqual([]);
  });
});
