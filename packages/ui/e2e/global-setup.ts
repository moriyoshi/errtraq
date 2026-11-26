import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { preview } from "vite";
import { seed } from "./seed.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const uiRoot = resolve(import.meta.dirname, "..");

async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? done(address.port)
          : fail(new Error("no port")),
      );
    });
  });
}

async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false>,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Starts `errtraq dev --stack stacks/local.ts` on a temporary data directory, seeds it with the
 * real Sentry SDK, and serves the built UI with `vite preview` (same-origin `/api/0` proxy, the
 * production CSP in force). Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const tmp = resolve(repo, ".agents-workspace/tmp");
  await mkdir(tmp, { recursive: true });
  const dataDir = await mkdtemp(join(tmp, "ui-e2e-"));
  let output = "";
  let errors = "";
  const server: ChildProcess = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "packages/cli/dist/bin.js",
      "dev",
      "--stack",
      "stacks/local.ts",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        ERRTRAQ_DATA_DIR: dataDir,
        ERRTRAQ_PORT: "0",
        ERRTRAQ_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.setEncoding("utf8").on("data", (c: string) => {
    output += c;
  });
  server.stderr?.setEncoding("utf8").on("data", (c: string) => {
    errors += c;
  });
  let previewServer: Awaited<ReturnType<typeof preview>> | undefined;
  const teardown = async () => {
    await previewServer?.close();
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once("exit", r));
      server.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await until(
      `server startup: ${errors}`,
      async () =>
        output.includes("Listening:") && output.includes("API token:"),
    );
    const dsn = output.match(/^DSN: (.+)$/m)?.[1];
    const token = output.match(/^API token: (.+)$/m)?.[1];
    const origin = output.match(/^Listening: (.+)$/m)?.[1];
    if (!dsn || !token || !origin)
      throw new Error(`unexpected startup output: ${output}`);
    await seed(dsn);
    await until("seeded issues", async () => {
      const response = await fetch(
        `${origin}/api/0/projects/default/default/issues/`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const rows = (await response.json()) as { count: string }[];
      return rows.length === 2 && rows.some((r) => r.count === "3");
    });
    // The Vite config reads this when preview() loads it.
    process.env.ERRTRAQ_API_TARGET = origin;
    const port = await freePort();
    previewServer = await preview({
      root: uiRoot,
      preview: { host: "127.0.0.1", port, strictPort: true },
      logLevel: "error",
    });
    process.env.ERRTRAQ_UI_URL = `http://127.0.0.1:${port}`;
    process.env.ERRTRAQ_TOKEN = token;
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
