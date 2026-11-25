// M4d spike, runs inside the runner container after bootstrap.mjs. Emits `RESULT {json}` lines
// (question, name, pass, detail) and `NOTE label: value` lines; the host smoke command parses them.
import { errText, lk, note, record, session, WB_HOST } from "./lib.mjs";

const ROWS = Number(process.env.SPIKE_ROWS ?? 50000);
const known = (id, name, fn) =>
  fn().then(
    (ok) => record(id, name, ok === true, ok === true ? "" : String(ok), true),
    (e) => record(id, name, false, errText(e), true),
  );
const q = (id, name, fn) =>
  fn().then(
    (ok) =>
      ok === undefined
        ? true
        : record(id, name, ok === true, ok === true ? "" : String(ok)),
    (e) => record(id, name, false, errText(e)),
  );
const sig = `AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`;
const wb = (method, path, headers = {}) =>
  fetch(`http://${WB_HOST}${path}`, {
    method,
    headers: { authorization: sig, ...headers },
  });

const DDL = (t, v) =>
  `CREATE TABLE lk.ns1.${t} (project_id VARCHAR, event_id VARCHAR, issue_id VARCHAR, received_at TIMESTAMPTZ, user_email VARCHAR, archive_batch VARCHAR, payload VARCHAR) WITH ('format-version' = ${v})`;
const gen = (n, batch, startDay, days) => `
  SELECT 'p' || (i % 5) AS project_id,
         'ev-${batch}-' || i AS event_id,
         'iss-' || (i % 50) AS issue_id,
         (TIMESTAMPTZ '${startDay} 00:00:00+00' + to_seconds(((i * 7919) % (${days} * 86400))::BIGINT)) AS received_at,
         'user' || (i % 97) || '@example.test' AS user_email,
         '${batch}' AS archive_batch,
         array_to_string(list_transform(range(30), lambda x: md5(i::VARCHAR || ':' || x::VARCHAR)), '') AS payload
  FROM range(${n}) t(i)`;

// ---- Q3 / Q4 first: catalog-level facts ----------------------------------------------------
const info = await lk("GET", "/management/v1/info");
const whs = await lk("GET", "/management/v1/warehouse");
const wh = whs.body?.warehouses?.find((w) => w.name === "errtraq");
note("lakekeeper info", {
  version: info.body.version,
  queues: info.body.queues,
  license: info.body["license-status"],
});
note("warehouse", wh);
await q(
  "Q1",
  "warehouse exists (created through Lakekeeper storage validation against winterbaume)",
  async () => (wh ? true : "warehouse errtraq not found"),
);
await q("Q3", "warehouse allows format-version 3 by default", async () => {
  const allowed = wh?.["allowed-format-versions"];
  note("format policy", { allowed, default: wh?.["default-format-version"] });
  return Array.isArray(allowed) && allowed.includes(3)
    ? true
    : `allowed-format-versions=${JSON.stringify(allowed)}`;
});
const queueNames = info.body.queues ?? [];
await known(
  "Q4",
  "expire_snapshots / orphan-file / optimize queues registered in the OSS image",
  async () => {
    const want = ["expire_snapshots", "remove_orphan_files", "optimize"];
    const have = want.filter((w) =>
      queueNames.some(
        (n) => n.includes(w) || (n.includes("orphan") && w.includes("orphan")),
      ),
    );
    return have.length === want.length
      ? true
      : `registered queues: ${queueNames.join(", ")}`;
  },
);
for (const name of [
  "expire_snapshots",
  "remove_orphan_files",
  "optimize",
  "tabular_expiration",
  "tabular_purge",
  "soft_deletion",
]) {
  const r = await lk(
    "GET",
    `/management/v1/warehouse/${wh?.id}/task-queue/${name}/config`,
  );
  note(`task-queue ${name} config`, { status: r.status, body: r.body });
}
const set = await lk(
  "POST",
  `/management/v1/warehouse/${wh?.id}/task-queue/expire_snapshots/config`,
  {
    "queue-config": {
      "enable-expire-snapshots": true,
      "max-snapshot-age-ms": 86400000,
    },
  },
);
note("expire_snapshots config POST", { status: set.status, body: set.body });

// ---- DDL in its own session (partition spec / sort order must exist before the first INSERT) -
const fileInfo = {};
await q(
  "Q2",
  "ATTACH + CREATE SCHEMA/TABLE v3 and v2, partition day(received_at), sort order (D13)",
  async () => {
    const s = await session();
    try {
      await s.run("CREATE SCHEMA IF NOT EXISTS lk.ns1");
      await s.run("DROP TABLE IF EXISTS lk.ns1.events");
      await s.run("DROP TABLE IF EXISTS lk.ns1.events_v2");
      await s.run(DDL("events", 3));
      await s.run(DDL("events_v2", 2));
      for (const t of ["events", "events_v2"]) {
        await s.run(
          `ALTER TABLE lk.ns1.${t} SET PARTITIONED BY (day(received_at))`,
        );
        await s.run(
          `ALTER TABLE lk.ns1.${t} SET SORTED BY (project_id, issue_id, received_at)`,
        );
        await s.run(
          `ALTER TABLE lk.ns1.${t} SET ('write.delete.mode' = 'merge-on-read')`,
        );
      }
      return true;
    } finally {
      s.close();
    }
  },
);
await q(
  "Q2",
  "format versions as stored by the catalog (v3 and v2)",
  async () => {
    const s = await session();
    try {
      const props = await s.run(
        "select * from iceberg_table_properties(lk.ns1.events) where key in ('format-version','write.delete.mode')",
      );
      note("events properties", props);
      const r = await lk(
        "GET",
        `/catalog/v1/${wh.id}/namespaces/ns1/tables/events`,
      );
      const r2 = await lk(
        "GET",
        `/catalog/v1/${wh.id}/namespaces/ns1/tables/events_v2`,
      );
      const v3 = r.body?.metadata?.["format-version"];
      const v2 = r2.body?.metadata?.["format-version"];
      note("loadTable", {
        v3,
        v2,
        specs: r.body?.metadata?.["partition-specs"],
        sort: r.body?.metadata?.["sort-orders"],
        cfg: r.body?.config,
      });
      return v3 === 3 && v2 === 2
        ? true
        : `v3=${v3} v2=${v2} (status ${r.status}/${r2.status})`;
    } finally {
      s.close();
    }
  },
);

// ---- Q2/Q5/Q6: append ----------------------------------------------------------------------
await q(
  "Q5",
  `INSERT ${ROWS} rows over 3 days into the v3 table (multipart upload traffic)`,
  async () => {
    const s = await session();
    try {
      const t0 = Date.now();
      await s.run(
        `INSERT INTO lk.ns1.events ${gen(ROWS, "b1", "2026-11-01", 3)}`,
      );
      note("insert ms", Date.now() - t0);
      const c = await s.run("select count(*) c from lk.ns1.events");
      // Integrity: checksum of what was generated vs what a FRESH session reads back through
      // winterbaume (multipart-written, range-read Parquet).
      const expected = (
        await s.run(
          `select sum(hash(event_id || payload)::HUGEINT)::VARCHAR h from (${gen(ROWS, "b1", "2026-11-01", 3)})`,
        )
      )[0].h;
      const fresh = await session();
      const actual = (
        await fresh.run(
          "select sum(hash(event_id || payload)::HUGEINT)::VARCHAR h from lk.ns1.events where archive_batch = 'b1'",
        )
      )[0].h;
      fresh.close();
      note("checksum", { expected, actual });
      if (expected !== actual)
        return `checksum mismatch expected=${expected} actual=${actual}`;
      const files = await s.run(
        "select file_path, record_count, content from iceberg_metadata(lk.ns1.events) where content = 'DATA'",
      );
      note(
        "data files",
        files.map((f) => ({
          p: f.file_path.split("/").pop(),
          n: f.record_count,
        })),
      );
      fileInfo.dataFiles = files;
      return c[0].c === String(ROWS) ? true : `count=${c[0].c}`;
    } finally {
      s.close();
    }
  },
);
await q(
  "Q5",
  "data file sizes and ranged GET against winterbaume",
  async () => {
    const f = fileInfo.dataFiles?.[0]?.file_path;
    if (!f) return "no data file";
    const key = f.replace("s3://", "/");
    const head = await wb("HEAD", key);
    const size = Number(head.headers.get("content-length"));
    const sizes = [];
    for (const d of fileInfo.dataFiles) {
      const h = await wb("HEAD", d.file_path.replace("s3://", "/"));
      sizes.push(Number(h.headers.get("content-length")));
    }
    note("data file sizes (bytes)", sizes);
    const r = await wb("GET", key, { range: `bytes=${size - 8}-${size - 1}` });
    const body = new Uint8Array(await r.arrayBuffer());
    const magic = new TextDecoder().decode(body.slice(4));
    const suffix = await wb("GET", key, { range: "bytes=-4" });
    const sb = new TextDecoder().decode(
      new Uint8Array(await suffix.arrayBuffer()),
    );
    note("range", {
      status: r.status,
      len: body.length,
      magic,
      suffixStatus: suffix.status,
      suffix: sb,
      cr: r.headers.get("content-range"),
    });
    return r.status === 206 &&
      body.length === 8 &&
      magic === "PAR1" &&
      suffix.status === 206 &&
      sb === "PAR1"
      ? true
      : `range status ${r.status} len ${body.length} magic ${magic}; suffix ${suffix.status} ${sb}`;
  },
);
await q(
  "Q2",
  "append second batch (b2, 200 rows, day 2026-11-02) and v2 table rows",
  async () => {
    const s = await session();
    try {
      await s.run(
        `INSERT INTO lk.ns1.events ${gen(200, "b2", "2026-11-02", 1)}`,
      );
      await s.run(
        `INSERT INTO lk.ns1.events_v2 ${gen(2000, "v2b1", "2026-11-01", 3)}`,
      );
      return true;
    } finally {
      s.close();
    }
  },
);

// ---- Q6: M4b operations --------------------------------------------------------------------
const filesRead = (rows) => {
  const text = rows.map((r) => Object.values(r).join("\n")).join("\n");
  const m = text.match(/Total Files Read:\s*(\d+)/i);
  return m ? Number(m[1]) : undefined;
};
await q(
  "Q6",
  "hasBatch probe (day-pruned count) answers true for b1, false for an unknown batch",
  async () => {
    const s = await session();
    try {
      const hit = await s.run(
        "select count(*) c from lk.ns1.events where archive_batch = 'b1' and received_at >= TIMESTAMPTZ '2026-11-01 00:00:00+00' and received_at < TIMESTAMPTZ '2026-11-04 00:00:00+00'",
      );
      const miss = await s.run(
        "select count(*) c from lk.ns1.events where archive_batch = 'nope' and received_at >= TIMESTAMPTZ '2026-11-01 00:00:00+00' and received_at < TIMESTAMPTZ '2026-11-04 00:00:00+00'",
      );
      return hit[0].c === String(ROWS) && miss[0].c === "0"
        ? true
        : `hit=${hit[0].c} miss=${miss[0].c}`;
    } finally {
      s.close();
    }
  },
);
await q(
  "Q6",
  "day partition pruning: a one-day predicate reads fewer files than the full scan",
  async () => {
    const s = await session();
    try {
      const all = await s.run(
        "explain analyze select count(*) from lk.ns1.events where archive_batch = 'b1'",
      );
      const one = await s.run(
        "explain analyze select event_id from lk.ns1.events where received_at >= TIMESTAMPTZ '2026-11-02 00:00:00+00' and received_at < TIMESTAMPTZ '2026-11-03 00:00:00+00' and archive_batch = 'b1'",
      );
      const a = filesRead(all);
      const b = filesRead(one);
      note("explain (full)", JSON.stringify(all).slice(0, 1500));
      note("files read", { full: a, oneDay: b });
      return a !== undefined && b !== undefined && b < a
        ? true
        : `files read full=${a} oneDay=${b}`;
    } finally {
      s.close();
    }
  },
);
await q(
  "Q6",
  "batchEventIds: keyset-free select of event_id for a batch returns exactly the batch rows",
  async () => {
    const s = await session();
    try {
      const r = await s.run(
        "select count(*) c, count(distinct event_id) d from (select event_id from lk.ns1.events where archive_batch = 'b2' and received_at >= TIMESTAMPTZ '2026-11-02 00:00:00+00' and received_at < TIMESTAMPTZ '2026-11-03 00:00:00+00' order by event_id)",
      );
      return r[0].c === "200" && r[0].d === "200" ? true : JSON.stringify(r);
    } finally {
      s.close();
    }
  },
);
await q(
  "Q6",
  "sort order is honored in written files (project_id, issue_id, received_at)",
  async () => {
    const s = await session();
    try {
      const f = fileInfo.dataFiles[0].file_path;
      const r = await s.run(
        `select count(*) c from (select project_id, issue_id, received_at, lag(project_id) over w pp, lag(issue_id) over w pi, lag(received_at) over w pr from read_parquet('${f}') window w as (order by file_row_number)) where pp is not null and (project_id < pp or (project_id = pp and (issue_id < pi or (issue_id = pi and received_at < pr))))`,
      );
      return r[0].c === "0" ? true : `${r[0].c} inversions`;
    } finally {
      s.close();
    }
  },
);

// ---- Q2: DELETE and deletion vectors --------------------------------------------------------
const delFiles = async (s, t) =>
  s.run(
    `select content, file_format, count(*) n, sum(record_count::BIGINT) rows from iceberg_metadata(lk.ns1.${t}) group by all order by all`,
  );
await q(
  "Q2",
  "v3: DELETE by batch/user writes deletion vectors (Puffin), reads honor them",
  async () => {
    const s = await session();
    try {
      const before = (
        await s.run(
          "select count(*) c from lk.ns1.events where user_email = 'user7@example.test'",
        )
      )[0].c;
      await s.run(
        "DELETE FROM lk.ns1.events WHERE user_email = 'user7@example.test'",
      );
      const after = (
        await s.run(
          "select count(*) c from lk.ns1.events where user_email = 'user7@example.test'",
        )
      )[0].c;
      const total = (await s.run("select count(*) c from lk.ns1.events"))[0].c;
      const fmt = await delFiles(s, "events");
      note("v3 files by content/format", fmt);
      note("v3 delete counts", { before, after, total });
      const snaps = await s.run(
        "select sequence_number, snapshot_id, summary from iceberg_snapshots(lk.ns1.events) order by sequence_number",
      );
      note(
        "v3 snapshots",
        snaps.map((r) => ({ seq: r.sequence_number, op: r.summary })),
      );
      const puffin = fmt.some(
        (r) => r.file_format === "puffin" || r.file_format === "PUFFIN",
      );
      if (after !== "0") return `rows remain: ${after}`;
      return puffin
        ? true
        : `no puffin deletion vector in ${JSON.stringify(fmt)}`;
    } finally {
      s.close();
    }
  },
);
await q(
  "Q2",
  "v3: a fresh session sees the delete; own commits are visible in-session with iceberg_use_metadata_log false (and true, for the record)",
  async () => {
    const fresh = await session();
    const stale = await session({ metadataLog: true });
    try {
      const expected = (
        await fresh.run("select count(*) c from lk.ns1.events")
      )[0].c;
      await stale.run(
        `INSERT INTO lk.ns1.events ${gen(10, "b3", "2026-11-03", 1)}`,
      );
      const sameSession = (
        await stale.run(
          "select count(*) c from lk.ns1.events where archive_batch = 'b3'",
        )
      )[0].c;
      const off = await session({ metadataLog: false });
      await off.run(
        `INSERT INTO lk.ns1.events ${gen(10, "b4", "2026-11-03", 1)}`,
      );
      const offSame = (
        await off.run(
          "select count(*) c from lk.ns1.events where archive_batch = 'b4'",
        )
      )[0].c;
      off.close();
      note("same-session read after own INSERT", {
        metadataLogTrue: sameSession,
        metadataLogFalse: offSame,
        freshBefore: expected,
      });
      return offSame === "10" ? true : `metadata_log=false read ${offSame}`;
    } finally {
      fresh.close();
      stale.close();
    }
  },
);
await q(
  "Q2",
  "v2 for comparison: DELETE writes positional deletes (Parquet), not Puffin",
  async () => {
    const s = await session();
    try {
      await s.run(
        "DELETE FROM lk.ns1.events_v2 WHERE user_email = 'user7@example.test'",
      );
      const fmt = await delFiles(s, "events_v2");
      note("v2 files by content/format", fmt);
      const after = (
        await s.run(
          "select count(*) c from lk.ns1.events_v2 where user_email = 'user7@example.test'",
        )
      )[0].c;
      return after === "0" &&
        fmt.some(
          (r) => /DELETE/i.test(r.content) && /parquet/i.test(r.file_format),
        )
        ? true
        : JSON.stringify(fmt);
    } finally {
      s.close();
    }
  },
);
await q(
  "Q5",
  "ranged reads: fresh-session aggregate and point read over the 50k-row table",
  async () => {
    const s = await session();
    try {
      const t0 = Date.now();
      const agg = await s.run(
        "select project_id, count(*) c, min(received_at)::VARCHAR lo from lk.ns1.events group by 1 order by 1",
      );
      const point = await s.run(
        "select payload from lk.ns1.events where event_id = 'ev-b1-12345'",
      );
      note("agg ms", Date.now() - t0);
      const total = agg.reduce((n, r) => n + Number(r.c), 0);
      return total > 0 && point.length === 1 && point[0].payload.length === 960
        ? true
        : `total ${total} point ${point.length}`;
    } finally {
      s.close();
    }
  },
);
await q(
  "Q5",
  "winterbaume still healthy and the data files round-trip byte-identically (read_blob vs HEAD size)",
  async () => {
    const s = await session();
    try {
      const f = fileInfo.dataFiles[0].file_path;
      const blob = await s.run(
        `select octet_length(content) n from read_blob('${f}')`,
      );
      const head = await wb("HEAD", f.replace("s3://", "/"));
      return String(blob[0].n) === head.headers.get("content-length")
        ? true
        : `blob ${blob[0].n} head ${head.headers.get("content-length")}`;
    } finally {
      s.close();
    }
  },
);

// ---- Lakekeeper side: table is visible / compaction on v3 ------------------------------------
await q(
  "Q4",
  "DuckDB iceberg_rewrite_data_files on v3 (known: unsupported in 2.0.0) and on v2",
  async () => {
    const s = await session();
    try {
      let v3 = "ok";
      try {
        await s.run(
          "CALL iceberg_rewrite_data_files(lk.ns1.events, rewrite_all := true)",
        );
      } catch (e) {
        v3 = errText(e);
      }
      let v2 = "ok";
      try {
        const r = await s.run(
          "CALL iceberg_rewrite_data_files(lk.ns1.events_v2, rewrite_all := true)",
        );
        note("v2 rewrite result", r);
      } catch (e) {
        v2 = errText(e);
      }
      note("rewrite", { v3, v2 });
      return true;
    } finally {
      s.close();
    }
  },
);
await known(
  "Q4",
  "Lakekeeper maintenance trigger endpoints exist (expire_snapshots / orphan / optimize)",
  async () => {
    const probes = [];
    for (const path of [
      `/management/v1/warehouse/${wh.id}/task-queue/expire_snapshots/config`,
      `/management/v1/warehouse/${wh.id}/task-queue/remove_orphan_files/config`,
      `/management/v1/warehouse/${wh.id}/task-queue/optimize/config`,
    ]) {
      const r = await lk("GET", path);
      probes.push({
        path: path.split("/task-queue/")[1],
        status: r.status,
        msg: r.body?.error?.message ?? "",
      });
    }
    note("queue config probes", probes);
    return probes.every((p) => p.status === 200)
      ? true
      : JSON.stringify(probes);
  },
);

// ---- winterbaume log summary is added by the host smoke command ------------------------------
console.log("SPIKE_DONE");
