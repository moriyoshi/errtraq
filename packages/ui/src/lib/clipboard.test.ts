import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("uses the Clipboard API when it works", async () => {
    const writeText = vi.fn(async () => {});
    const fallback = vi.fn(() => true);
    expect(await copyText("dsn", { clipboard: { writeText }, fallback })).toBe(
      true,
    );
    expect(writeText).toHaveBeenCalledWith("dsn");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back when the API is missing or refuses", async () => {
    const fallback = vi.fn(() => true);
    expect(await copyText("a", { fallback })).toBe(true);
    const clipboard = {
      writeText: async () => {
        throw new Error("denied");
      },
    };
    expect(await copyText("b", { clipboard, fallback })).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("reports failure instead of throwing", async () => {
    expect(await copyText("x", {})).toBe(false);
    expect(
      await copyText("x", {
        fallback: () => {
          throw new Error("no");
        },
      }),
    ).toBe(false);
  });
});
