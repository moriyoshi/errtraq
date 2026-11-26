import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@moriyoshi/errtraq-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { create } from "./index.js";
import { configSchema } from "./stack.js";

const HTML = "<!doctype html><title>errtraq</title>";
let dir: string;
let ui: string;
let outside: string;
let platform: ReturnType<typeof create>;
let base: string;

function start(
  config: Parameters<typeof create>[0]["config"],
  environment?: Record<string, string>,
) {
  return create({
    config,
    dependencies: {
      store: new MemoryActiveStore(),
      blob: new MemoryBlobStore(),
      kv: new MemoryKV(),
      queue: Object.assign(new MemoryQueue(), { idle: async () => true }),
    },
    bindings: {},
    ...(environment ? { environment } : {}),
  });
}
/** A raw request: `fetch` normalizes `..` and encoded dots before they reach the server. */
function raw(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1", () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nAccept: text/html\r\nConnection: close\r\n\r\n`,
      ),
    );
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "errtraq-ui-"));
  ui = join(dir, "dist");
  outside = join(dir, "secret");
  await mkdir(join(ui, "assets"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(ui, "index.html"), HTML);
  await writeFile(join(ui, "assets", "index-abc.js"), "export {};");
  await writeFile(join(ui, "assets", "index-abc.css"), "body{}");
  await writeFile(join(ui, "favicon.svg"), "<svg/>");
  await writeFile(join(ui, ".hidden"), "nope");
  await writeFile(join(outside, "token.txt"), "TOP-SECRET");
  await writeFile(join(dir, "sibling.txt"), "TOP-SECRET");
  await symlink(outside, join(ui, "escape"));
  await symlink(join(outside, "token.txt"), join(ui, "assets", "link.js"));
  platform = start({ port: 0, uiDirectory: ui });
  const server = await platform.start();
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await platform.close();
  await rm(dir, { recursive: true, force: true });
});

const html = { accept: "text/html,application/xhtml+xml" };

describe("standalone UI hosting", () => {
  it("serves index.html at / with no-cache and the framing headers", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HTML);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    const explicit = await fetch(`${base}/index.html`);
    expect(explicit.headers.get("cache-control")).toBe("no-cache");
  });
  it("serves hashed assets as immutable and other files uncached", async () => {
    const script = await fetch(`${base}/assets/index-abc.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(script.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("content-security-policy")).toBeNull();
    const css = await fetch(`${base}/assets/index-abc.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const icon = await fetch(`${base}/favicon.svg`);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
    const head = await fetch(`${base}/assets/index-abc.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("10");
  });
  it("falls back to index.html for navigations only", async () => {
    const route = await fetch(`${base}/org/project/issues/12`, {
      headers: html,
    });
    expect(route.status).toBe(200);
    expect(await route.text()).toBe(HTML);
    expect(route.headers.get("cache-control")).toBe("no-cache");
    // A missing script or stylesheet must stay a 404, not an HTML body.
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect(
      (await fetch(`${base}/assets/missing.js`, { headers: { accept: "*/*" } }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/org/project`, { method: "POST" })).status,
    ).toBe(404);
  });
  it("never serves the fallback under /api/ and keeps API and ingest routes", async () => {
    for (const path of ["/api/0/unknown", "/api/1/unknown", "/api/", "/api"]) {
      const response = await fetch(`${base}${path}`, { headers: html });
      expect(await response.text()).not.toContain("<title>");
      expect(response.headers.get("content-type")).not.toContain("text/html");
    }
    // Unauthenticated API call keeps its own JSON 401; /health stays the health check.
    const api = await fetch(`${base}/api/0/organizations/`, { headers: html });
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ detail: "Authentication required" });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      status: "ok",
    });
    expect(
      (await fetch(`${base}/api/1/envelope/`, { method: "POST" })).status,
    ).not.toBe(200);
  });
  it("refuses traversal, encoded dots, dotfiles and symbolic links out of the directory", async () => {
    const attempts = [
      "/../sibling.txt",
      "/assets/../../sibling.txt",
      "/%2e%2e/sibling.txt",
      "/%2E%2E%2Fsibling.txt",
      "/assets/%2e%2e/%2e%2e/sibling.txt",
      "/..%2fsibling.txt",
      "/assets/..%5c..%5csibling.txt",
      "/.hidden",
      "/%00",
      "/escape/token.txt",
      "/assets/link.js",
    ];
    const port = Number(new URL(base).port);
    for (const path of attempts) {
      const response = await raw(port, path);
      expect(response, path).not.toContain("TOP-SECRET");
    }
    // A navigation to a dotfile is refused outright, not answered with the SPA shell.
    expect(await raw(port, "/.hidden")).toContain("404");
    expect(await raw(port, "/escape/token.txt")).toContain(
      "<title>errtraq</title>",
    );
    // Through fetch as well, with the navigation Accept that would otherwise fall back.
    for (const path of ["/escape/token.txt", "/assets/link.js"]) {
      const response = await fetch(`${base}${path}`, { headers: html });
      expect(await response.text(), path).not.toContain("TOP-SECRET");
    }
  });
  it("refuses a missing directory or one without index.html at start", async () => {
    await expect(
      start({ port: 0, uiDirectory: join(dir, "nowhere") }).start(),
    ).rejects.toThrow("not a directory");
    await expect(
      start({ port: 0, uiDirectory: outside }).start(),
    ).rejects.toThrow("no index.html");
  });
  it("lets ERRTRAQ_UI_DIR override the setting and serves nothing without either", async () => {
    const overridden = start(
      { port: 0, uiDirectory: join(dir, "nowhere") },
      { ERRTRAQ_UI_DIR: ui },
    );
    const server = await overridden.start();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/x`, {
        headers: html,
      });
      expect(await response.text()).toBe(HTML);
    } finally {
      await overridden.close();
    }
    const plain = start({ port: 0 });
    const running = await plain.start();
    try {
      expect(
        (await fetch(`http://127.0.0.1:${running.port}/`, { headers: html }))
          .status,
      ).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("standalone API CORS", () => {
  it("validates exact origins", () => {
    expect(
      configSchema.parse({ apiCorsOrigins: ["https://ui.example.com"] })
        .apiCorsOrigins,
    ).toEqual(["https://ui.example.com"]);
    for (const bad of [
      "*",
      "https://ui.example.com/",
      "https://ui.example.com/path",
      "ui.example.com",
      "null",
      "ftp://ui.example.com",
    ])
      expect(
        configSchema.safeParse({ apiCorsOrigins: [bad] }).success,
        bad,
      ).toBe(false);
    expect(configSchema.safeParse({ apiCorsOrigins: [] }).success).toBe(false);
  });
  it("adds CORS headers to the API only when origins are configured", async () => {
    const origin = "https://ui.example.com";
    const request = (port: number) =>
      fetch(`http://127.0.0.1:${port}/api/0/`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
    const on = start({ port: 0, apiCorsOrigins: [origin] });
    const onServer = await on.start();
    const off = start({ port: 0 });
    const offServer = await off.start();
    try {
      const allowed = await request(onServer.port);
      expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
      expect(allowed.headers.get("access-control-allow-headers")).toMatch(
        /authorization/i,
      );
      expect(
        (await request(offServer.port)).headers.get(
          "access-control-allow-origin",
        ),
      ).toBeNull();
    } finally {
      await on.close();
      await off.close();
    }
  });
});
