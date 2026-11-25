import { parquetMetadata, parquetReadObjects } from "hyparquet/src/index.js";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_STAGING_PREFIX,
  ArchiveStagingError,
  decodeStagedBatch,
  encodeStagedBatch,
  parseStagingKey,
  readStagedEventIds,
  selectBatchPrefix,
  stagingKey,
  summarizeBatch,
} from "./archive-staging.js";
import type { StoredEvent, Timestamp } from "./domain.js";

const ev = (
  id: string,
  receivedAt: string,
  extra: Partial<StoredEvent> = {},
): StoredEvent =>
  ({
    projectId: "7",
    eventId: id,
    issueId: "issue",
    timestamp: receivedAt as Timestamp,
    receivedAt: receivedAt as Timestamp,
    level: "error",
    tags: {},
    payload: { id },
    ...extra,
  }) as StoredEvent;

describe("staged batch codec", () => {
  it("round trips unicode, nulls, tags, users and many days", async () => {
    const rows = [
      ev("a", "2024-01-01T23:59:59.999Z", {
        release: "1.0",
        environment: "prod",
        tags: { k: "値", "": "empty-key" },
        user: { id: "u", email: "e@x", username: "名前", ipAddress: "::1" },
        payload: {
          msg: "日本語 \u{1F600} \u0000",
          nested: { n: [1, 2, null] },
        },
        payloadBlobKey: "blob/key",
        expiresAt: "2025-01-01T00:00:00.000Z" as Timestamp,
      }),
      ev("b", "2024-01-03T00:00:00.000Z"),
      ev("c", "2023-12-31T00:00:00.001Z", { user: { email: "only@x" } }),
    ];
    const enc = encodeStagedBatch("7/1", rows);
    expect(enc.rowCount).toBe(3);
    expect(enc.dayRange).toEqual(["2023-12-31", "2024-01-03"]);
    expect(enc.maxReceivedAt).toBe("2024-01-03T00:00:00.000Z");
    expect(enc.eventIds).toEqual(["a", "b", "c"]);
    const dec = await decodeStagedBatch(enc.bytes);
    expect(dec.batchId).toBe("7/1");
    expect(dec.rows).toEqual(rows);
    expect(await readStagedEventIds(enc.bytes)).toEqual(["a", "b", "c"]);
  });

  it("writes DuckDB-friendly columns", async () => {
    const enc = encodeStagedBatch("7/1", [
      ev("a", "2024-01-01T00:00:00.123Z", { tags: { a: "b" } }),
    ]);
    const buf = enc.bytes.buffer.slice(
      enc.bytes.byteOffset,
      enc.bytes.byteOffset + enc.bytes.byteLength,
    ) as ArrayBuffer;
    const meta = parquetMetadata(buf);
    const ts = meta.schema.find((s) => s.name === "received_at");
    expect(ts?.type).toBe("INT64");
    expect(ts?.logical_type).toMatchObject({
      type: "TIMESTAMP",
      isAdjustedToUTC: true,
      unit: "MICROS",
    });
    expect(meta.schema.find((s) => s.name === "tags")?.converted_type).toBe(
      "MAP",
    );
    const [row] = await parquetReadObjects({ file: buf });
    expect(row?.tags).toEqual({ a: "b" });
    expect(row?.archive_batch).toBe("7/1");
    expect((row?.received_at as Date | undefined)?.toISOString()).toBe(
      "2024-01-01T00:00:00.123Z",
    );
  });

  it("round trips large payloads", async () => {
    const big = "x".repeat(2_000_000);
    const rows = [ev("big", "2024-01-01T00:00:00.000Z", { payload: { big } })];
    const dec = await decodeStagedBatch(encodeStagedBatch("7/2", rows).bytes);
    expect(dec.rows).toEqual(rows);
    const many = Array.from({ length: 2500 }, (_, i) =>
      ev(`e${i}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`),
    );
    expect(
      (await decodeStagedBatch(encodeStagedBatch("7/3", many).bytes)).rows,
    ).toEqual(many);
  });

  it("rejects empty batches, bad limits and unreadable bytes", async () => {
    expect(() => encodeStagedBatch("b", [])).toThrow(ArchiveStagingError);
    expect(() => summarizeBatch([])).toThrow(ArchiveStagingError);
    expect(() =>
      encodeStagedBatch("b", [ev("a", "2024-01-01T00:00:00.000Z")], {
        maxRows: 0,
        maxBytes: 1,
      }),
    ).toThrow(ArchiveStagingError);
    await expect(
      decodeStagedBatch(new TextEncoder().encode("not parquet")),
    ).rejects.toBeInstanceOf(ArchiveStagingError);
    await expect(readStagedEventIds(new Uint8Array(0))).rejects.toBeInstanceOf(
      ArchiveStagingError,
    );
  });

  it("enforces size bounds", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      ev(`e${i}`, "2024-01-01T00:00:00.000Z"),
    );
    expect(
      selectBatchPrefix(rows, { maxRows: 4, maxBytes: 1e9 }).map(
        (r) => r.eventId,
      ),
    ).toEqual(["e0", "e1", "e2", "e3"]);
    expect(selectBatchPrefix(rows, { maxRows: 100, maxBytes: 1 })).toHaveLength(
      1,
    );
    expect(selectBatchPrefix(rows)).toHaveLength(10);
    expect(() =>
      encodeStagedBatch("b", rows, { maxRows: 4, maxBytes: 1e9 }),
    ).toThrow(/rows/);
    expect(() =>
      encodeStagedBatch("b", rows, { maxRows: 100, maxBytes: 100 }),
    ).toThrow(/bytes/);
  });

  it("builds and parses staging keys", () => {
    const parts = { batchId: "7/12", owner: "w-1.a b/c", attempt: 3 };
    const key = stagingKey(parts);
    expect(key.startsWith(ARCHIVE_STAGING_PREFIX)).toBe(true);
    expect(key.endsWith(".parquet")).toBe(true);
    expect(key.slice(ARCHIVE_STAGING_PREFIX.length)).not.toContain("/");
    expect(parseStagingKey(key)).toEqual(parts);
    expect(stagingKey({ ...parts, owner: "other" })).not.toBe(key);
    expect(stagingKey({ ...parts, attempt: 4 })).not.toBe(key);
    for (const bad of [
      "other/x.parquet",
      `${ARCHIVE_STAGING_PREFIX}a-b.parquet`,
      `${ARCHIVE_STAGING_PREFIX}a-b-01.parquet`,
      `${ARCHIVE_STAGING_PREFIX}a-b-1.json`,
      `${ARCHIVE_STAGING_PREFIX}%ZZ-b-1.parquet`,
    ])
      expect(parseStagingKey(bad)).toBeNull();
    expect(() => stagingKey({ ...parts, attempt: -1 })).toThrow();
    expect(() => stagingKey({ ...parts, owner: "" })).toThrow();
  });
});
