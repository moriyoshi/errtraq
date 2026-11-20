import { it } from "vitest";
import { assertStackHelper } from "../../../../scripts/adapter-stack-check.js";
import { sqlite } from "./stack.js";

it("validates the stack helper without importing runtime code", async () => {
  await assertStackHelper(
    sqlite({ path: ":memory:" }),
    new URL("./stack.ts", import.meta.url),
  );
});
