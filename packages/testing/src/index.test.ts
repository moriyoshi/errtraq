import { expect, it } from "vitest";

it("has a buildable entry point", async () => {
  await expect(import("./index.js")).resolves.toBeDefined();
});
