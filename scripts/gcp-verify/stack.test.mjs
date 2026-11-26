import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderRunStack, writeRunStack } from "./stack.mjs";

describe("run stack derivation", () => {
  it("reads project, region and operator from the environment only", () => {
    const text = renderRunStack({});
    expect(text).toContain('requiredEnv("ERRTRAQ_GCP_PROJECT")');
    expect(text).toContain('requiredEnv("ERRTRAQ_GCP_OPERATOR_MEMBER")');
    expect(text).toContain('protection: "disposable"');
    expect(text).toContain('recordMode: "grouped"');
    expect(text).not.toContain("ingress");
  });
  it("can put the push and Scheduler callees behind internal ingress and set the rate limit", () => {
    const text = renderRunStack({ ingressInternal: true, rateLimit: null });
    expect(text).toContain('consumer: { ingress: "internal" }');
    expect(text).toContain("rateLimit: null");
  });
  it("rejects names that would not fit the service account ids", () => {
    expect(() =>
      renderRunStack({ stackName: "this-name-is-way-too-long-for-us" }),
    ).toThrow("20");
    expect(() => renderRunStack({ rateLimit: 0 })).toThrow("rateLimit");
  });
  it("copies the example stacks with .ts specifiers beside the stack", async () => {
    mkdirSync(resolve(".agents-workspace/tmp"), { recursive: true });
    const directory = mkdtempSync(
      join(resolve(".agents-workspace/tmp"), "g8-stack-"),
    );
    await writeRunStack(resolve("."), directory);
    expect(readFileSync(join(directory, "gcp-firestore.ts"), "utf8")).toContain(
      'from "./gcp-env.ts"',
    );
    expect(readFileSync(join(directory, "stack.ts"), "utf8")).toContain(
      'from "./gcp-firestore.ts"',
    );
  });
});
