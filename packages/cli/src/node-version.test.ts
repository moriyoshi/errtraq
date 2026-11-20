import { expect, it } from "vitest";
import { assertNodeVersion } from "./node-version.js";

it("requires a Node release with default TypeScript stripping", () => {
  expect(() => assertNodeVersion("22.17.1")).toThrow(
    "Node.js ^22.18.0 or >=23.6.0 is required",
  );
  expect(() => assertNodeVersion("20.19.0")).toThrow(
    "Node.js ^22.18.0 or >=23.6.0 is required",
  );
  expect(() => assertNodeVersion("23.5.0")).toThrow(
    "Node.js ^22.18.0 or >=23.6.0 is required",
  );
  expect(() => assertNodeVersion("22.18.0")).not.toThrow();
  expect(() => assertNodeVersion("23.6.0")).not.toThrow();
  expect(() => assertNodeVersion("24.0.0")).not.toThrow();
});
