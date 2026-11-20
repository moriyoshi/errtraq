import { it } from "vitest";
import { assertStackHelper } from "../../../../scripts/adapter-stack-check.js";
import { fsBlob } from "./stack.js";

it("validates the stack helper without importing runtime code", async () => {
  await assertStackHelper(
    fsBlob({ root: ".agents-workspace/tmp" }),
    new URL("./stack.ts", import.meta.url),
  );
});
