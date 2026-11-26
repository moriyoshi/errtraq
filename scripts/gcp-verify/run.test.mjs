import { describe, expect, it } from "vitest";
import { ALL, DEFAULT_ORDER, selectProbes } from "./run.mjs";

describe("probe selection", () => {
  it("runs everything but the inventory by default", () => {
    expect(selectProbes({}).map((probe) => probe.name)).toEqual(DEFAULT_ORDER);
    expect(DEFAULT_ORDER).not.toContain("inventory");
  });
  it("selects by name and rejects unknown names", () => {
    expect(
      selectProbes({ probes: "inventory,gcs" }).map((probe) => probe.name),
    ).toEqual(["inventory", "gcs"]);
    expect(() => selectProbes({ probes: "nope" })).toThrow(
      "Unknown probe: nope",
    );
    for (const [_key, probe] of Object.entries(ALL))
      expect(typeof probe.run).toBe("function");
  });
});
