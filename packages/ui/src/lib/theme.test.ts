import { describe, expect, it } from "vitest";
import {
  applyTheme,
  loadTheme,
  parseTheme,
  resolveTheme,
  saveTheme,
  THEME_KEY,
} from "./theme";

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}
const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("theme", () => {
  it("resolves the three choices against the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("accepts only the known choices", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    for (const v of ["system", "sepia", "", null, undefined, 1])
      expect(parseTheme(v)).toBe("system");
  });

  it("round-trips through storage and falls back to system without it", () => {
    const s = memory();
    expect(loadTheme(s)).toBe("system");
    saveTheme("dark", s);
    expect(s.data[THEME_KEY]).toBe("dark");
    expect(loadTheme(s)).toBe("dark");
    expect(loadTheme(memory({ [THEME_KEY]: "junk" }))).toBe("system");
    expect(loadTheme(undefined)).toBe("system");
  });

  it("survives storage that throws", () => {
    expect(loadTheme(throwing)).toBe("system");
    expect(() => saveTheme("light", throwing)).not.toThrow();
  });

  it("sets data-theme for light and dark and removes it for system", () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n),
    };
    applyTheme("dark", root);
    expect(attrs.get("data-theme")).toBe("dark");
    applyTheme("light", root);
    expect(attrs.get("data-theme")).toBe("light");
    applyTheme("system", root);
    expect(attrs.has("data-theme")).toBe(false);
  });
});
