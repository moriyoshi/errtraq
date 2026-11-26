import { describe, expect, it } from "vitest";
import { claimReload, RELOAD_INTERVAL_MS } from "./proxy";

const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

describe("proxy reload limit", () => {
  it("allows one reload a minute and then refuses", () => {
    const store = memory();
    expect(claimReload(store, 1_000_000)).toBe(true);
    expect(claimReload(store, 1_000_000 + RELOAD_INTERVAL_MS - 1)).toBe(false);
    expect(claimReload(store, 1_000_000 + RELOAD_INTERVAL_MS)).toBe(true);
  });
  it("refuses when it cannot remember, so a reload loop is impossible", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(claimReload(broken, 5)).toBe(false);
  });
});
