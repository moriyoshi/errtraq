import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

// Opt-in browser test: skip with a clear message when the browser or the build is missing.
const here = resolve(import.meta.dirname, "..");
const browser = chromium.executablePath();
if (!existsSync(browser)) {
  console.log(
    `SKIP e2e:ui: Playwright Chromium is not installed (${browser}). Install it with: pnpm --filter @moriyoshi/errtraq-ui exec playwright install chromium`,
  );
  process.exit(0);
}
if (!existsSync(resolve(here, "dist/index.html"))) {
  console.error(
    "The UI is not built. Run: pnpm --filter @moriyoshi/errtraq-ui build",
  );
  process.exit(1);
}
if (!existsSync(resolve(here, "../cli/dist/bin.js"))) {
  console.error("The CLI is not built. Run: pnpm build");
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [
    resolve(here, "node_modules/@playwright/test/cli.js"),
    "test",
    "--config",
    resolve(here, "playwright.config.ts"),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", cwd: here },
);
process.exit(result.status ?? 1);
