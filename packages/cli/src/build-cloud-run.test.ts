import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { containsLocalPath } from "@moriyoshi/errtraq-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import loaded from "../../../stacks/gcp-firestore.js";
import { buildStack, cloudRunDockerfile } from "./build.js";
import { CLOUD_RUN_ARTIFACT, generateInfra } from "./infra.js";

vi.hoisted(() => {
  // The example stack has no default project or region; set them before it is imported.
  process.env.ERRTRAQ_GCP_PROJECT = "example-project";
  process.env.ERRTRAQ_GCP_REGION = "europe-west1";
});
const repo = process.cwd();
let temp: string;
beforeAll(async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(resolve(repo, ".agents-workspace/tmp"), { recursive: true });
  temp = await mkdtemp(resolve(repo, ".agents-workspace/tmp/g5-build-"));
}, 30000);
afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolvePort(address.port)
          : reject(new Error("no port")),
      );
    });
  });

describe("Cloud Run build", () => {
  it("renders a non-root image that selects each bundle by command", () => {
    const dockerfile = cloudRunDockerfile({ functionIds: ["ingest", "api"] });
    expect(dockerfile).toContain("FROM node:26.13.1-bookworm-slim");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain(
      "COPY --chown=node:node ingest/index.mjs /app/ingest/index.mjs",
    );
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).not.toMatch(/^ENTRYPOINT/m);
  });
  it("builds one bundle per function plus the Dockerfile, with no local paths", async () => {
    const output = resolve(temp, "gcp");
    const manifest = await buildStack(
      loaded,
      repo,
      output,
      resolve(repo, "stacks/gcp-firestore.ts"),
    );
    expect(manifest.platform).toBe("cloud-run");
    expect(manifest.dockerfile).toBe("Dockerfile");
    expect(Object.keys(manifest.artifacts).sort()).toEqual([
      "api",
      "consumer",
      "cron",
      "ingest",
      "record",
    ]);
    for (const artifact of Object.values(manifest.artifacts))
      expect(artifact).toMatchObject({
        ...CLOUD_RUN_ARTIFACT,
        packaging: "image",
      });
    const dockerfile = await readFile(resolve(output, "Dockerfile"), "utf8");
    for (const id of Object.keys(manifest.artifacts))
      expect(dockerfile).toContain(`/app/${id}/index.mjs`);
    const bundle = await readFile(
      resolve(output, "consumer/index.mjs"),
      "utf8",
    );
    expect(containsLocalPath(bundle, repo)).toBe(false);
    // The consumer bundle verifies Pub/Sub tokens and never reads a key file.
    expect(bundle).toContain("ERRTRAQ_PUSH_SERVICE_ACCOUNT");
    expect(bundle).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    // The infra generator accepts the recorded artifacts (hash, handler, runtime) without
    // placeholders. `pnpm infra:validate` runs `terraform validate` on the generated google roots.
    const summary = await generateInfra(
      loaded,
      repo,
      resolve(temp, "infra"),
      output,
      false,
    );
    expect(summary).toContain("Generated Terraform");
    expect(summary).not.toContain("placeholders");
  }, 60000);
  it("starts on PORT and stays up when the deployment bindings are missing", async () => {
    const output = resolve(temp, "gcp");
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [resolve(output, "ingest/index.mjs")],
      {
        env: { PORT: String(port), PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout.on("data", (chunk) => {
      logs += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      logs += String(chunk);
    });
    try {
      let status = 0;
      for (let attempt = 0; attempt < 50 && !status; attempt++) {
        try {
          status = (await fetch(`http://127.0.0.1:${port}/_errtraq/health`))
            .status;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      // Initialization fails (no bindings), which the server reports as 503 instead of crashing.
      expect(status).toBe(503);
      expect(child.exitCode).toBeNull();
      expect(logs).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    } finally {
      child.kill("SIGTERM");
    }
  }, 30000);
});
