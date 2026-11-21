import { describe, expect, it, vi } from "vitest";
import {
  constructDeployedPlan,
  type DeployedPlan,
} from "./deployed-runtime.js";

describe("deployed secret delivery", () => {
  it("passes a secret source and the identifier binding to adapter construction", async () => {
    const read = vi.fn(async (id: string) => `resolved:${id}`);
    const plan: DeployedPlan = {
      variables: {},
      selections: [
        {
          path: "store",
          id: "example",
          kind: "store",
          runtimeModule: "example",
          config: {},
          dependsOn: {},
          bindings: [{ name: "SECRET_ID", kind: "secret" }],
        },
      ],
      topics: {},
      queueConsumers: [],
    };
    const built = await constructDeployedPlan(
      plan,
      { SECRET_ID: "secret-identifier" },
      async () => ({
        create: async (ctx: {
          bindings: Record<string, string>;
          secretSource: { read(id: string): Promise<string> };
        }) => ctx.secretSource.read(ctx.bindings.SECRET_ID ?? ""),
      }),
      undefined,
      { read },
    );
    expect(built.instances.get("store")).toBe("resolved:secret-identifier");
    expect(read).toHaveBeenCalledWith("secret-identifier");
    await built.close();
  });
});
