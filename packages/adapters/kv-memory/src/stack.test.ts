import { it } from "vitest";
import { assertStackHelper } from "../../../../scripts/adapter-stack-check.js";
import { memoryKv } from "./stack.js";

it("validates the stack helper without importing runtime code", async () => {
  await assertStackHelper(memoryKv({}), new URL("./stack.ts", import.meta.url));
});
