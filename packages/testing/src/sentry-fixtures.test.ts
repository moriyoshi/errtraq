import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  containsLocalPath,
  parseEnvelope,
  parseEventPayload,
} from "@errtraq/core";
import { describe, expect, it } from "vitest";

const directory = new URL("../fixtures/sentry/", import.meta.url);
const script = new URL("../scripts/scrub-sentry-fixtures.mjs", import.meta.url);
const repository = resolve(import.meta.dirname, "../../..");
const forbidden = [hostname(), userInfo().username].filter(
  (value) => value.length >= 5,
);

function expectClean(data: Uint8Array, name: string) {
  const content = Buffer.from(data);
  expect(
    containsLocalPath(content.toString("utf8"), repository),
    `${name} contains a local path`,
  ).toBe(false);
  for (const secret of forbidden)
    expect(
      content.includes(Buffer.from(secret)),
      `${name} contains a local identifier`,
    ).toBe(false);
}

describe("Sentry capture fixtures", () => {
  it("contains no current machine identifiers and has valid envelope framing", async () => {
    const files = await readdir(directory);
    expect(files.some((name) => name.endsWith(".envelope"))).toBe(true);
    for (const name of files) {
      const data = await readFile(new URL(name, directory));
      expectClean(data, name);
      if (name.endsWith(".envelope")) {
        const parsed = parseEnvelope(data);
        for (const item of parsed.items) {
          if (item.headers.length !== undefined)
            expect(item.headers.length, name).toBe(item.payload.length);
          if (item.headers.type === "event") {
            const event = parseEventPayload(item.payload);
            expect(event.server_name, name).toBe("fixture-host");
            const contexts = event.contexts as Record<
              string,
              Record<string, unknown>
            >;
            if (contexts?.device)
              expect(contexts.device.cpu_description).toBe("Fixture CPU");
            if (contexts?.culture)
              expect(contexts.culture.timezone).toBe("UTC");
          }
        }
      }
      if (name.endsWith(".gz")) {
        const raw = gunzipSync(data);
        expectClean(raw, name);
        expect(raw).toEqual(
          await readFile(new URL(name.slice(0, -3), directory)),
        );
        parseEnvelope(raw);
      }
    }
  });
  it("scrubs raw captures, keeps field types and binary data, and fixes byte lengths", async () => {
    const root = resolve(".agents-workspace/tmp");
    await mkdir(root, { recursive: true });
    const temp = await mkdtemp(join(root, "scrub-fixtures-"));
    try {
      const input = join(temp, "raw");
      const output = join(temp, "scrubbed");
      await mkdir(input);
      const original = {
        attributes: {
          "device.archs": { value: ["arm64"], type: "array" },
          "culture.timezone": { value: "Asia/Tokyo", type: "string" },
          "app.memory": { value: 1234, type: "integer" },
        },
        server_name: hostname(),
        message: `${repository}/${userInfo().username}`,
        contexts: {
          device: {
            arch: "private",
            memory_size: 42,
            processor_count: 12,
            cpu_description: "private CPU",
          },
          os: {
            kernel_version: "private",
            version: "private",
            build: "private",
          },
          app: { app_start_time: "2020-01-01T00:00:00Z", app_memory: 42 },
          culture: { locale: "private", timezone: "private" },
          cloud_resource: { cloud_region: "private", nested: { count: 7 } },
        },
      };
      const event = Buffer.from(JSON.stringify(original));
      const attachment = Buffer.concat([
        Buffer.from([0, 10, 255]),
        Buffer.from(hostname()),
        Buffer.from([10, 1]),
      ]);
      const envelope = Buffer.concat([
        Buffer.from("{}\n"),
        Buffer.from(
          `${JSON.stringify({ type: "event", length: event.length })}\n`,
        ),
        event,
        Buffer.from("\n"),
        Buffer.from(
          `${JSON.stringify({ type: "attachment", length: attachment.length })}\n`,
        ),
        attachment,
        Buffer.from("\n"),
      ]);
      await writeFile(join(input, "large.envelope"), envelope);
      const result = spawnSync(
        process.execPath,
        [script.pathname, input, output],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const scrubbed = await readFile(join(output, "large.envelope"));
      expectClean(scrubbed, "generated fixture");
      const parsed = parseEnvelope(scrubbed);
      const first = parsed.items[0];
      const second = parsed.items[1];
      if (!first || !second) throw new Error("Missing fixture items");
      expect(first.headers.length).toBe(first.payload.length);
      expect(second.headers.length).toBe(second.payload.length);
      const eventResult = parseEventPayload(first.payload);
      expect(eventResult).toMatchObject({
        attributes: {
          "device.archs": { value: ["x86_64"], type: "array" },
          "culture.timezone": { value: "UTC", type: "string" },
          "app.memory": { value: 67108864, type: "integer" },
        },
        server_name: "fixture-host",
        message: "/fixture/project/fixture",
        contexts: {
          device: {
            arch: "x86_64",
            memory_size: 1073741824,
            processor_count: 2,
            cpu_description: "Fixture CPU",
          },
          os: {
            kernel_version: "1.0.0",
            version: "1.0.0",
            build: "fixture-build",
          },
          app: {
            app_start_time: "2024-01-01T00:00:00.000Z",
            app_memory: 67108864,
          },
          culture: { locale: "en-US", timezone: "UTC" },
          cloud_resource: { cloud_region: "fixture", nested: { count: 0 } },
        },
      });
      expect(Array.from(second.payload.slice(0, 3))).toEqual([0, 10, 255]);
      expect(
        gunzipSync(await readFile(join(output, "large.envelope.gz"))),
      ).toEqual(scrubbed);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
