import { describe, expect, it } from "vitest";
import {
  createAuth,
  createHttp,
  createScrubber,
  loadConfig,
  loadOutputs,
  parseFlags,
  poll,
  pool,
} from "./lib.mjs";
import { PROJECT, REGION, routerFetch } from "./testing.mjs";

const config = { project: PROJECT, region: REGION };

describe("configuration", () => {
  it("has no default project or region", () => {
    expect(() => loadConfig({}, {})).toThrow("project");
    expect(() => loadConfig({ project: PROJECT }, {})).toThrow("region");
    const loaded = loadConfig(
      {},
      { ERRTRAQ_GCP_PROJECT: PROJECT, ERRTRAQ_GCP_REGION: REGION },
    );
    expect(loaded.stack).toBe("gcp-g8");
  });
  it("parses flags", () => {
    expect(parseFlags(["--a", "1", "--b", "--c=3", "x"])).toEqual({
      flags: { a: "1", b: true, c: "3" },
      positional: ["x"],
    });
  });
  it("reads terraform outputs", async () => {
    expect(
      await loadOutputs("o.json", async () =>
        JSON.stringify({ a: { value: "1" } }),
      ),
    ).toEqual({ a: "1" });
    await expect(loadOutputs("o.json", async () => "nope")).rejects.toThrow(
      "Terraform outputs",
    );
  });
});

describe("scrubbing", () => {
  it("removes project, region, e-mail, URLs and tokens", () => {
    const { scrub, addSecret } = createScrubber(config);
    addSecret("hunter2-key");
    const text = `${PROJECT} ${REGION} a@b.example https://x.run.app/p eyJhbGciOi.eyJzdWIi.sig ya29.abc hunter2-key`;
    expect(scrub(text)).toBe(
      "<project> <region> <email> <url> <token> <token> <secret>",
    );
  });
});

describe("helpers", () => {
  it("polls with an injected clock and times out", async () => {
    let time = 0;
    const clock = {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    };
    let calls = 0;
    expect(await poll(clock, "x", async () => ++calls === 3 && "done")).toBe(
      "done",
    );
    await expect(
      poll(clock, "never", async () => false, {
        timeoutMs: 5000,
        intervalMs: 1000,
      }),
    ).rejects.toThrow("timed out: never");
  });
  it("bounds concurrency and keeps order", async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 1));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
  it("scrubs network errors and never throws on a status", async () => {
    const { scrub } = createScrubber(config);
    const auth = { accessToken: async () => "tok" };
    const failing = createHttp({
      fetch: async () => {
        throw new Error(`connect ${PROJECT}`);
      },
      auth,
      scrub,
    });
    expect((await failing("GET", "https://x")).error).toBe(
      "Error: connect <project>",
    );
    const log = [];
    const http = createHttp({
      fetch: routerFetch([["GET", /./, () => ({ status: 404 })]], log),
      auth,
      scrub,
    });
    expect((await http("GET", "https://x")).status).toBe(404);
    expect(log[0].init.headers.authorization).toBe("Bearer tok");
    await http("GET", "https://x", { token: "none" });
    expect(log[1].init.headers.authorization).toBeUndefined();
  });
  it("mints ID tokens by impersonation, never from nothing", async () => {
    const log = [];
    const fetch = routerFetch(
      [
        [
          "POST",
          /generateIdToken$/,
          (_u, init) => ({
            body: { token: `t-${JSON.parse(init.body).audience}` },
          }),
        ],
      ],
      log,
    );
    const auth = createAuth({
      env: {
        ERRTRAQ_GCP_ACCESS_TOKEN: "a",
        ERRTRAQ_GCP_IMPERSONATE_SA: "sa@p.iam.gserviceaccount.com",
      },
      fetch,
    });
    expect(await auth.idToken("aud")).toBe("t-aud");
    expect(log[0].url).toContain("sa%40p.iam.gserviceaccount.com");
    await expect(createAuth({ env: {} }).idToken("aud")).rejects.toThrow(
      "No ID token source",
    );
    await expect(createAuth({ env: {} }).accessToken()).rejects.toThrow(
      "ERRTRAQ_GCP_ACCESS_TOKEN",
    );
  });
});
