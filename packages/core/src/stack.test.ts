import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineStack,
  env,
  out,
  type PortKind,
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
  store: selection("store", { textSearch: false }),
  queue: selection("queue", { delivery: "push" }),
  blob: selection("blob"),
  kv: selection("kv"),
});
describe("stack validation", () => {
  it("accepts a compatible stack and preserves references", () => {
    const value = stack();
    expect(defineStack(value)).toBe(value);
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
});
