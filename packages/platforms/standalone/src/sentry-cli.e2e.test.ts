import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import {
  type ApiTokenId,
  bootstrapProject,
  ConsumerService,
  hashApiToken,
  WebCryptoIdGen,
} from "@moriyoshi/errtraq-core";
import { createApiApp } from "@moriyoshi/errtraq-http";
import {
  FakeClock,
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
} from "@moriyoshi/errtraq-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Opt-in: set ERRTRAQ_SENTRY_CLI to a sentry-cli executable (or `sentry-cli` on PATH) to run the
 * real client against the API app on a loopback port. It never leaves the machine.
 */
const cli = process.env.ERRTRAQ_SENTRY_CLI;
const run = promisify(execFile);

describe.skipIf(!cli)("sentry-cli against the API app", () => {
  const store = new MemoryActiveStore();
  const blobs = new MemoryBlobStore();
  let server: ReturnType<typeof serve>;
  let dir: string;
  let env: Record<string, string>;
  let projectId: string;
  let publicApi: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    const clock = new FakeClock();
    const boot = await bootstrapProject({
      store,
      kv: new MemoryKV(clock),
      ids: new WebCryptoIdGen(),
      orgSlug: "org",
      projectSlug: "project",
    });
    projectId = boot.project.id;
    await store.projects.putToken({
      id: "t" as ApiTokenId,
      orgId: boot.org.id,
      tokenHash: await hashApiToken("errtraq_secret"),
      scopes: ["event:read", "event:write"],
    });
    const app = createApiApp({ store, clock, blobs });
    publicApi = app;
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    dir = await mkdtemp(join(tmpdir(), "errtraq-sentry-cli-"));
    env = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      SENTRY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      SENTRY_AUTH_TOKEN: "errtraq_secret",
      SENTRY_ORG: "org",
      SENTRY_PROJECT: "project",
      SENTRY_DISABLE_UPDATE_CHECK: "1",
    };
    await mkdir(join(dir, "dist"));
    await writeFile(
      join(dir, "dist", "app.js"),
      "console.log('hi');\n//# sourceMappingURL=app.js.map\n",
    );
    await writeFile(
      join(dir, "dist", "app.js.map"),
      JSON.stringify({
        version: 3,
        file: "app.js",
        sources: ["src/app.ts"],
        sourcesContent: ["console.log('hi');"],
        names: [],
        mappings: "AAAA",
      }),
    );
  });
  afterAll(async () => {
    server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const sentry = (...args: string[]) =>
    run(cli as string, args, { env, cwd: dir, timeout: 60_000 });

  it("creates, uploads, finalizes and lists a release", async () => {
    await sentry("releases", "new", "v1");
    await sentry("sourcemaps", "inject", "dist");
    const injected = await readFile(join(dir, "dist", "app.js"), "utf8");
    const debugId = /debugId=([0-9a-f-]{36})/.exec(injected)?.[1];
    expect(debugId).toBeTruthy();
    await sentry("sourcemaps", "upload", "--release", "v1", "dist");
    const bundle = await store.releases.findBundleByDebugId(
      projectId as never,
      debugId as string,
    );
    expect(bundle?.state).toBe("active");
    // Uploading the same build again is a no-op rather than a debug ID conflict.
    await sentry("sourcemaps", "upload", "--release", "v1", "dist");
    await sentry("releases", "finalize", "v1");
    await sentry("deploys", "new", "--release", "v1", "-e", "production");
    const listed = await sentry("releases", "list");
    expect(listed.stdout).toContain("v1");
    await symbolicates(debugId as string, injected);
    expect(
      (await store.releases.getReleaseByVersion(projectId as never, "v1"))
        ?.finalizedAt,
    ).toBeTruthy();
  });

  /** A minified-stack event processed by the consumer comes back symbolicated through the API. */
  async function symbolicates(debugId: string, injected: string) {
    // `inject` prepends a snippet and shifts the map, so locate the original code in the file.
    const lines = injected.split("\n");
    const lineIndex = lines.findIndex((line) =>
      line.includes("console.log('hi')"),
    );
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    const column = (lines[lineIndex] ?? "").indexOf("console.log('hi')");
    const eventId = "0123456789abcdef0123456789abcdef";
    const script = "https://example.com/dist/app.js";
    const event = {
      event_id: eventId,
      platform: "javascript",
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                {
                  abs_path: script,
                  filename: "/dist/app.js",
                  function: "?",
                  lineno: lineIndex + 1,
                  colno: column + 1,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [{ type: "sourcemap", code_file: script, debug_id: debugId }],
      },
    };
    const blobKey = `envelopes/${projectId}/e2e`;
    await blobs.put(
      blobKey,
      new TextEncoder().encode(
        `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`,
      ),
    );
    const consumer = new ConsumerService({
      store,
      blobs,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const result = await consumer.handle([
      {
        id: "e2e",
        topic: "ingest",
        attempt: 1,
        message: {
          key: eventId,
          body: {
            projectId,
            blobKey,
            receivedAt: new Date().toISOString(),
          },
        },
      },
    ]);
    expect(result).toEqual([{ deliveryId: "e2e", action: "ack" }]);
    const response = await publicApi.request(
      `http://errtraq.test/api/0/projects/org/project/events/${eventId}`,
      { headers: { authorization: "Bearer errtraq_secret" } },
    );
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("src/app.ts");
    expect(body).toContain("console.log('hi');");
    expect(body).toContain('"symbolicated":true');
  }
});
