// Opt-in: the full ArchiveStore contract against the DuckDB engine, Lakekeeper and winterbaume.
//
//   export WINTERBAUME_BINARY=<linux winterbaume-server>   # see scripts/archive-local/smoke.mjs
//   docker compose -p errtraq-archive -f docker/archive/compose.yaml \
//     -f docker/archive/compose.ports.yaml up -d --build --wait
//   docker compose -p errtraq-archive -f docker/archive/compose.yaml exec -T runner node bootstrap.mjs
//   ERRTRAQ_LAKEKEEPER_URL=http://127.0.0.1:18181/catalog pnpm exec vitest run duckdb/lakekeeper.opt-in
//   docker compose -p errtraq-archive -f docker/archive/compose.yaml down -v
//
// Needs `@duckdb/node-api` to load (it is skipped otherwise, like without ERRTRAQ_LAKEKEEPER_URL).
// ERRTRAQ_LAKEKEEPER_WAREHOUSE defaults to `errtraq`; ERRTRAQ_ARCHIVE_S3_ENDPOINT is where DuckDB
// reaches winterbaume (default 127.0.0.1:15555, published by compose.ports.yaml; use
// `winterbaume:5555` when the tests run inside the compose network). The erasure cases stay
// skipped until M4l; everything else of archiveStoreContract runs.
import { archiveStoreContract } from "@moriyoshi/errtraq-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { configSchema } from "../stack.js";
import { create } from "./index.js";
import type { DuckDbArchiveStore } from "./store.js";

const uri = process.env.ERRTRAQ_LAKEKEEPER_URL;
const duck = await import("@duckdb/node-api").catch(() => undefined);
const enabled = Boolean(uri && duck);

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const warehouse = process.env.ERRTRAQ_LAKEKEEPER_WAREHOUSE ?? "errtraq";
const s3Endpoint = process.env.ERRTRAQ_ARCHIVE_S3_ENDPOINT ?? "127.0.0.1:15555";
const stores: DuckDbArchiveStore[] = [];
let counter = 0;

function config(namespace: string, formatVersion: 2 | 3 = 3) {
  return configSchema.parse({
    catalog: { uri: uri ?? "", warehouse },
    namespace,
    engine: {
      formatVersion,
      homeDirectory:
        process.env.ERRTRAQ_DUCKDB_HOME ?? "/tmp/errtraq-duckdb-test",
      s3: {
        endpoint: s3Endpoint,
        urlStyle: "path",
        useSsl: false,
        region: "us-east-1",
      },
    },
  });
}
function open(namespace: string, formatVersion: 2 | 3 = 3): DuckDbArchiveStore {
  const store = create({
    config: config(namespace, formatVersion),
    bindings: {},
    dependencies: {},
    environment: { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" },
  });
  stores.push(store);
  return store;
}
const unique = () =>
  `m4f_${Date.now().toString(36)}_${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
});

describe.skipIf(!enabled)("DuckDB engine against Lakekeeper", () => {
  archiveStoreContract(
    async () => {
      const store = open(unique());
      expect(await store.ensureTable()).toEqual({ created: true });
      return store;
    },
    { rowDelete: "deletion-vector", erasure: false },
  );

  it("creates the table once with the configured format, partition, sort order and delete mode", async () => {
    const namespace = unique();
    const store = open(namespace);
    expect(await store.ensureTable()).toEqual({ created: true });
    expect(await store.ensureTable()).toEqual({ created: false });
    const response = await fetch(
      `${(uri ?? "").replace(/\/catalog$/, "")}/management/v1/warehouse`,
    );
    const warehouses = (await response.json()) as {
      warehouses: { id: string; name: string }[];
    };
    const id = warehouses.warehouses.find((w) => w.name === warehouse)?.id;
    const table = (await (
      await fetch(`${uri}/v1/${id}/namespaces/${namespace}/tables/events`)
    ).json()) as { metadata: Record<string, unknown> };
    const metadata = table.metadata as {
      "format-version": number;
      properties: Record<string, string>;
      "partition-specs": { fields: { name: string; transform: string }[] }[];
      "sort-orders": { fields: { transform: string }[] }[];
    };
    expect(metadata["format-version"]).toBe(3);
    expect(metadata.properties["write.delete.mode"]).toBe("merge-on-read");
    expect(
      metadata["partition-specs"].at(-1)?.fields.map((f) => f.transform),
    ).toEqual(["day"]);
    expect(metadata["sort-orders"].at(-1)?.fields).toHaveLength(3);
  });

  it("sees batches committed by another session and survives concurrent writers", async () => {
    const namespace = unique();
    const first = open(namespace);
    await first.ensureTable();
    const second = open(namespace);
    const event = (id: string, second: number) => ({
      projectId: "p" as never,
      eventId: id as never,
      issueId: "i" as never,
      timestamp:
        `2024-03-01T10:00:${String(second).padStart(2, "0")}.000Z` as never,
      receivedAt:
        `2024-03-01T10:00:${String(second).padStart(2, "0")}.000Z` as never,
      level: "error" as const,
      tags: {},
      payload: { id },
    });
    const day = ["2024-03-01", "2024-03-01"] as never;
    await first.append({ batchId: "x", dayRange: day, rows: [event("a", 1)] });
    expect(await second.hasBatch("x", day)).toBe(true);
    const writers = [first, second, open(namespace), open(namespace)];
    const results = await Promise.all(
      writers.map((store, index) =>
        store.append({
          batchId: `c${index}`,
          dayRange: day,
          rows: [event(`w${index}`, 10 + index)],
        }),
      ),
    );
    expect(results).toHaveLength(4);
    const page = await first.query({
      projectId: "p" as never,
      limit: 50,
      order: "asc",
    });
    expect(page.items.map((e) => e.eventId)).toEqual([
      "a",
      "w0",
      "w1",
      "w2",
      "w3",
    ]);
  });
});
