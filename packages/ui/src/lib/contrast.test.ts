/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast of the colour tokens in both themes. The stylesheet is parsed, not copied, so a
 * token edit that breaks AA fails here. Text needs 4.5:1; focus rings and chart marks need 3:1
 * (non-text contrast) against the surfaces they sit on.
 */

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  );
}
function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed block after ${marker}`);
}

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const light = tokens(blockAfter(":root {"));
const darkExplicit = tokens(blockAfter(':root[data-theme="dark"]'));
const darkSystem = tokens(blockAfter(':root:not([data-theme="light"])'));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground token, background token] pairs that carry text. */
const TEXT: [string, string][] = [
  ["ink", "bg"],
  ["ink", "surface"],
  ["ink", "code-bg"],
  ["ink", "hl"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "code-bg"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accent", "code-bg"],
  ["accent", "chip-bg"],
  ["accent-ink", "accent"],
  ["danger", "danger-bg"],
  ["danger", "surface"],
  ["warn", "warn-bg"],
  ["warn", "surface"],
  ["ok", "surface"],
  ["ok", "bg"],
];
/** Focus rings, sparkline, bars and axis: 3:1 against the surfaces they are drawn on. */
const GRAPHICS: [string, string][] = [
  ["accent", "surface"],
  ["accent", "bg"],
  ["accent", "code-bg"],
  ["muted", "surface"],
];

describe("colour tokens", () => {
  it("defines the same tokens in every theme", () => {
    expect(Object.keys(darkExplicit).sort()).toEqual(Object.keys(light).sort());
  });

  it("keeps the system-dark block identical to data-theme=dark", () => {
    expect(darkSystem).toEqual(darkExplicit);
  });

  for (const [name, theme] of [
    ["light", light],
    ["dark", darkExplicit],
  ] as const) {
    it(`meets WCAG AA for text in the ${name} theme`, () => {
      for (const [fg, bg] of TEXT) {
        const value = ratio(theme[fg] as string, theme[bg] as string);
        expect(value, `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`meets 3:1 for focus rings and chart marks in the ${name} theme`, () => {
      for (const [fg, bg] of GRAPHICS) {
        const value = ratio(theme[fg] as string, theme[bg] as string);
        expect(value, `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
