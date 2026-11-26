import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("gcp-emulated test stack", () => {
  it("validates and puts every role in one function", async () => {
    vi.stubEnv("ERRTRAQ_GCP_EMULATOR_GCS_ENDPOINT", "http://127.0.0.1:4443");
    vi.resetModules();
    const core = await import("@moriyoshi/errtraq-core");
    const stack = (await import("./stack.js")).default;
    const view = core.deriveDeployment(stack);
    expect(view.functions.map((fn) => fn.id)).toEqual(["shared"]);
    expect(view.triggers.some((t) => t.kind === "queue")).toBe(true);
    // The push switch is on, and only the emulator-only guard makes that safe.
    expect(stack.queue.config).toMatchObject({ pushAuth: "none" });
  });
  it("needs the emulator origin from the harness", async () => {
    vi.stubEnv("ERRTRAQ_GCP_EMULATOR_GCS_ENDPOINT", "");
    vi.resetModules();
    await expect(import("./stack.js")).rejects.toThrow(/set by the harness/);
  });
});
