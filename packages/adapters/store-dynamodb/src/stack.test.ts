import { out } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { configSchema, infra, manifest } from "./stack.js";

describe("DynamoDB store deployment configuration", () => {
  it("accepts one through four integral index shards", () => {
    for (const indexShards of [1, 2, 3, 4])
      expect(configSchema.safeParse({ indexShards }).success).toBe(true);
    for (const indexShards of [0, 5, 1.5])
      expect(configSchema.safeParse({ indexShards }).success).toBe(false);
  });
  it("declares separate metadata and event deletion capabilities", () => {
    expect(manifest.capabilities.deleteBySubject).toBe(false);
    expect(infra.capabilities["metadata-delete"]?.primary).not.toEqual(
      infra.capabilities.delete?.primary,
    );
  });
  it("scopes grouped-consumer project reads to a distinct policy output", () => {
    expect(infra.capabilities["project-read"]?.primary).toEqual(
      out("policies", "project-read", "primary"),
    );
    for (const other of ["read", "write", "key-read"])
      expect(infra.capabilities["project-read"]?.primary).not.toEqual(
        infra.capabilities[other]?.primary,
      );
  });
});
