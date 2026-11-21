import { expect, it } from "vitest";
import { buildSummary, dsnHost, dsnOrigin } from "./address.js";

it("maps wildcard addresses to a usable localhost DSN", () => {
  expect(dsnHost("0.0.0.0")).toBe("localhost");
  expect(dsnHost("::")).toBe("localhost");
  expect(dsnHost("127.0.0.1")).toBe("127.0.0.1");
  expect(dsnHost("::1")).toBe("[::1]");
  expect(dsnOrigin("0.0.0.0", 8787)).toEqual({
    origin: "http://localhost:8787",
    fallback: true,
  });
  expect(dsnOrigin("0.0.0.0", 8787, "https://errors.example:444")).toEqual({
    origin: "https://errors.example:444",
    fallback: false,
  });
});
it("reports the standalone bundle and Dockerfile", () => {
  const summary = buildSummary("local", "dist/local", "standalone", 0);
  expect(summary).toContain("dist/local/shared/index.mjs");
  expect(summary).toContain("dist/local/Dockerfile");
  expect(summary).not.toContain("0 deployable artifacts");
});
