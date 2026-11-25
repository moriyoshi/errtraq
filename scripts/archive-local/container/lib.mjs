// Shared helpers for the in-container spike scripts.
import { mkdirSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

export const WB_HOST = "winterbaume:5555";
export const LK = process.env.LAKEKEEPER_URL ?? "http://lakekeeper:8181";
export const WAREHOUSE = "errtraq";
export const BUCKET = "errtraq-archive";

const results = [];
export function record(question, name, pass, detail = "", known = false) {
  const entry = {
    question,
    name,
    pass,
    known,
    detail: String(detail).slice(0, 600),
  };
  results.push(entry);
  console.log(`RESULT ${JSON.stringify(entry)}`);
  return pass;
}
export function note(label, value) {
  console.log(
    `NOTE ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/** One DuckDB instance + connection with the iceberg catalog attached (a "session"). */
export async function session({ metadataLog = false, attach = true } = {}) {
  mkdirSync("/tmp/duckhome", { recursive: true });
  const instance = await DuckDBInstance.create(":memory:", {
    home_directory: "/tmp/duckhome",
    // Keep the unsigned-extension default; official extensions are signed.
  });
  const conn = await instance.connect();
  const run = async (sql) => {
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJson();
  };
  await run("INSTALL httpfs; INSTALL avro; INSTALL iceberg;");
  await run("LOAD httpfs; LOAD avro; LOAD iceberg;");
  await run(
    `CREATE SECRET wb (TYPE s3, KEY_ID 'test', SECRET 'test', REGION 'us-east-1', ENDPOINT '${WB_HOST}', URL_STYLE 'path', USE_SSL false)`,
  );
  if (attach) {
    await run(
      `ATTACH '${WAREHOUSE}' AS lk (TYPE iceberg, ENDPOINT '${LK}/catalog', AUTHORIZATION_TYPE 'none', ACCESS_DELEGATION_MODE 'none')`,
    );
  }
  await run(`SET iceberg_use_metadata_log = ${metadataLog}`);
  return {
    run,
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

export async function lk(method, path, body) {
  const res = await fetch(`${LK}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

export function errText(e) {
  return e instanceof Error ? e.message : String(e);
}
