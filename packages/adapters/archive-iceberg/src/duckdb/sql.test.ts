import type {
  Day,
  EventId,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { configSchema } from "../stack.js";
import { attachSql, instanceOptions, s3SecretSql } from "./attach.js";
import {
  appendStatement,
  batchEventIdsStatement,
  dayRangeBounds,
  ensureTableStatements,
  getEventStatement,
  hasBatchStatement,
  queryStatement,
  quoteIdentifier,
  quoteLiteral,
  snapshotsStatement,
  tableRef,
} from "./sql.js";

const day = (value: string) => value as Day;
const project = "p1" as ProjectId;
const event = (
  id: string,
  overrides: Partial<StoredEvent> = {},
): StoredEvent => ({
  projectId: project,
  eventId: id as EventId,
  issueId: "i1" as StoredEvent["issueId"],
  timestamp: "2024-03-01T10:00:00.000Z" as Timestamp,
  receivedAt: "2024-03-01T10:00:01.000Z" as Timestamp,
  level: "error",
  tags: { k: "v" },
  payload: { id },
  ...overrides,
});
const settings = (engine: object = {}, catalog: object = {}) =>
  configSchema.parse({
    catalog: {
      uri: "http://lk:8181/catalog",
      warehouse: "errtraq",
      ...catalog,
    },
    engine,
  });

describe("identifiers and literals", () => {
  it("quotes valid identifiers and rejects anything else", () => {
    expect(quoteIdentifier("received_at")).toBe('"received_at"');
    for (const bad of ["", "a b", 'a"b', "1a", "a;drop", "a.b"])
      expect(() => quoteIdentifier(bad)).toThrow(TypeError);
    expect(tableRef("errtraq")).toBe('lake."errtraq"."events"');
  });
  it("escapes literals and rejects NUL", () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(() => quoteLiteral("a\0b")).toThrow(TypeError);
  });
});

describe("DDL", () => {
  it("creates the table with the promoted columns, partition, D13 sort order and merge-on-read", () => {
    const statements = ensureTableStatements("errtraq", 3);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS lake."errtraq"');
    expect(statements[1]).toContain(`WITH ('format-version' = 3)`);
    for (const column of [
      '"project_id" VARCHAR',
      '"timestamp" TIMESTAMPTZ',
      '"received_at" TIMESTAMPTZ',
      '"tags" MAP(VARCHAR, VARCHAR)',
      '"user_email" VARCHAR',
      '"event" VARCHAR',
      '"archive_batch" VARCHAR',
    ])
      expect(statements[1]).toContain(column);
    expect(statements[2]).toBe(
      'ALTER TABLE lake."errtraq"."events" SET PARTITIONED BY (day(received_at))',
    );
    expect(statements[3]).toBe(
      'ALTER TABLE lake."errtraq"."events" SET SORTED BY (project_id, issue_id, received_at)',
    );
    expect(statements[4]).toBe(
      `ALTER TABLE lake."errtraq"."events" SET ('write.delete.mode' = 'merge-on-read')`,
    );
    expect(ensureTableStatements("errtraq", 2)[1]).toContain(
      "'format-version' = 2",
    );
  });
});

describe("append", () => {
  it("binds the whole batch as one JSON parameter and keeps event data out of the SQL", () => {
    const hostile = event("e1", {
      user: { email: "x'); DROP TABLE events; --" },
    });
    const statement = appendStatement("errtraq", "batch-1", [
      hostile,
      event("e2"),
    ]);
    expect(statement.sql.match(/\?/g)).toHaveLength(1);
    expect(statement.sql).not.toContain("DROP TABLE");
    expect(statement.sql).toContain('INSERT INTO lake."errtraq"."events"');
    expect(statement.params).toHaveLength(1);
    const rows = JSON.parse(String(statement.params[0])) as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      project_id: "p1",
      event_id: "e1",
      archive_batch: "batch-1",
      user_email: "x'); DROP TABLE events; --",
      tags: { k: "v" },
    });
    expect(JSON.parse(String(rows[0]?.event))).toMatchObject({ eventId: "e1" });
  });
  it("rejects an overflow payload and an empty batch id", () => {
    expect(() => appendStatement("errtraq", "", [event("e1")])).toThrow();
    expect(() =>
      appendStatement("errtraq", "b", [event("e1", { payloadBlobKey: "k" })]),
    ).toThrow();
  });
});

describe("day ranges", () => {
  it("covers the inclusive range as a half-open UTC interval", () => {
    expect(dayRangeBounds([day("2024-03-01"), day("2024-03-02")])).toEqual([
      "2024-03-01T00:00:00.000Z",
      "2024-03-03T00:00:00.000Z",
    ]);
    expect(dayRangeBounds([day("2024-02-28"), day("2024-02-29")])[1]).toBe(
      "2024-03-01T00:00:00.000Z",
    );
  });
  it("rejects malformed, impossible and reversed days", () => {
    expect(() =>
      dayRangeBounds([day("2024-3-1"), day("2024-03-02")]),
    ).toThrow();
    expect(() =>
      dayRangeBounds([day("2024-02-30"), day("2024-03-02")]),
    ).toThrow();
    expect(() =>
      dayRangeBounds([day("2024-03-05"), day("2024-03-02")]),
    ).toThrow();
    expect(() =>
      dayRangeBounds([day("2024-03-01'; --"), day("2024-03-02")]),
    ).toThrow();
  });
  it("prunes hasBatch and batchEventIds by the range", () => {
    const range: [Day, Day] = [day("2024-03-01"), day("2024-03-02")];
    expect(hasBatchStatement("errtraq", "b", range)).toEqual({
      sql: 'SELECT 1 AS found FROM lake."errtraq"."events" WHERE archive_batch = ? AND received_at >= CAST(? AS TIMESTAMPTZ) AND received_at < CAST(? AS TIMESTAMPTZ) LIMIT 1',
      params: ["b", "2024-03-01T00:00:00.000Z", "2024-03-03T00:00:00.000Z"],
    });
    expect(
      hasBatchStatement("errtraq", "b", range, { snapshotId: "42" }).sql,
    ).toContain('"events" AT (VERSION => 42) WHERE');
    expect(() =>
      hasBatchStatement("errtraq", "b", range, { snapshotId: "1; DROP" }),
    ).toThrow();
    expect(batchEventIdsStatement("errtraq", project, "b", range)).toEqual({
      sql: 'SELECT event_id FROM lake."errtraq"."events" WHERE project_id = ? AND archive_batch = ? AND received_at >= CAST(? AS TIMESTAMPTZ) AND received_at < CAST(? AS TIMESTAMPTZ) ORDER BY event_id',
      params: [
        "p1",
        "b",
        "2024-03-01T00:00:00.000Z",
        "2024-03-03T00:00:00.000Z",
      ],
    });
    expect(snapshotsStatement("errtraq").sql).toContain("iceberg_snapshots(");
  });
});

describe("query", () => {
  it("builds a descending keyset page by default", () => {
    expect(
      queryStatement(
        "errtraq",
        { projectId: project },
        {
          receivedAt: "2024-03-01T10:00:01.000Z" as Timestamp,
          eventId: "e5" as EventId,
        },
        10,
      ),
    ).toEqual({
      sql: 'SELECT event FROM lake."errtraq"."events" WHERE project_id = ? AND (received_at, event_id) < (CAST(? AS TIMESTAMPTZ), ?) ORDER BY received_at DESC, event_id DESC LIMIT ?',
      params: ["p1", "2024-03-01T10:00:01.000Z", "e5", 11],
    });
  });
  it("adds issue and half-open range predicates in ascending order", () => {
    const statement = queryStatement(
      "errtraq",
      {
        projectId: project,
        issueId: "i1" as StoredEvent["issueId"],
        from: "2024-03-01T00:00:00.000Z" as Timestamp,
        to: "2024-03-02T00:00:00.000Z" as Timestamp,
        order: "asc",
      },
      undefined,
      2,
    );
    expect(statement.sql).toBe(
      'SELECT event FROM lake."errtraq"."events" WHERE project_id = ? AND issue_id = ? AND received_at >= CAST(? AS TIMESTAMPTZ) AND received_at < CAST(? AS TIMESTAMPTZ) ORDER BY received_at ASC, event_id ASC LIMIT ?',
    );
    expect(statement.params).toEqual([
      "p1",
      "i1",
      "2024-03-01T00:00:00.000Z",
      "2024-03-02T00:00:00.000Z",
      3,
    ]);
  });
  it("never puts caller values into the SQL text", () => {
    const evil = "x' OR '1'='1";
    const statement = queryStatement(
      "errtraq",
      { projectId: evil as ProjectId, issueId: evil as StoredEvent["issueId"] },
      { receivedAt: evil as Timestamp, eventId: evil as EventId },
      1,
    );
    expect(statement.sql).not.toContain("OR '1'");
    expect(statement.params.filter((p) => p === evil)).toHaveLength(4);
  });
  it("prunes a point lookup to the hint day only when given", () => {
    expect(
      getEventStatement("errtraq", project, "e1" as EventId).params,
    ).toEqual(["p1", "e1"]);
    const hinted = getEventStatement(
      "errtraq",
      project,
      "e1" as EventId,
      day("2024-03-01"),
    );
    expect(hinted.sql).toContain("received_at >= CAST(? AS TIMESTAMPTZ)");
    expect(hinted.params).toEqual([
      "p1",
      "e1",
      "2024-03-01T00:00:00.000Z",
      "2024-03-02T00:00:00.000Z",
    ]);
  });
});

describe("engine settings", () => {
  it("sets the home directory and, in container mode, turns autoinstall and autoload off", () => {
    expect(instanceOptions(settings().engine)).toEqual({
      home_directory: "/tmp/errtraq-duckdb",
    });
    expect(
      instanceOptions(
        settings({
          extensionMode: "preinstalled",
          extensionDirectory: "/opt/duckdb/extensions",
          memoryLimit: "768MB",
          threads: 2,
          homeDirectory: "/tmp/h",
        }).engine,
      ),
    ).toEqual({
      home_directory: "/tmp/h",
      extension_directory: "/opt/duckdb/extensions",
      memory_limit: "768MB",
      threads: "2",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
    });
  });
  it("builds the S3 secret with optional endpoint, path style and session token", () => {
    const engine = settings({
      s3: { endpoint: "winterbaume:5555", urlStyle: "path", useSsl: false },
    }).engine;
    expect(
      s3SecretSql(engine, "us-east-1", {
        accessKeyId: "a'b",
        secretAccessKey: "s",
        sessionToken: "t",
      }),
    ).toBe(
      "CREATE OR REPLACE SECRET errtraq_s3 (TYPE s3, REGION 'us-east-1', KEY_ID 'a''b', SECRET 's', SESSION_TOKEN 't', ENDPOINT 'winterbaume:5555', URL_STYLE 'path', USE_SSL false)",
    );
    expect(s3SecretSql(settings().engine, "eu-west-1", undefined)).toBe(
      "CREATE OR REPLACE SECRET errtraq_s3 (TYPE s3, REGION 'eu-west-1', URL_STYLE 'vhost', USE_SSL true)",
    );
  });
  it("attaches Lakekeeper without delegation and S3 Tables by endpoint type", () => {
    const lakekeeper = settings();
    expect(attachSql(lakekeeper.catalog, lakekeeper.engine)).toBe(
      "ATTACH 'errtraq' AS lake (TYPE iceberg, ENDPOINT 'http://lk:8181/catalog', AUTHORIZATION_TYPE 'none', ACCESS_DELEGATION_MODE 'none')",
    );
    const s3 = settings(
      { catalogType: "s3_tables" },
      {
        uri: "https://s3tables.us-east-1.amazonaws.com/iceberg",
        warehouse: "arn:aws:s3tables:us-east-1:000000000000:bucket/b",
        auth: { type: "sigv4", region: "us-east-1" },
      },
    );
    expect(attachSql(s3.catalog, s3.engine)).toBe(
      "ATTACH 'arn:aws:s3tables:us-east-1:000000000000:bucket/b' AS lake (TYPE iceberg, ENDPOINT_TYPE s3_tables)",
    );
  });
  it("rejects a missing warehouse, s3_tables without sigv4 and unsupported lakekeeper auth", () => {
    const none = configSchema.parse({ catalog: { uri: "http://lk" } });
    expect(() => attachSql(none.catalog, none.engine)).toThrow(/warehouse/);
    const noSig = settings({ catalogType: "s3_tables" });
    expect(() => attachSql(noSig.catalog, noSig.engine)).toThrow(/sigv4/);
    const bearer = settings({}, { auth: { type: "bearer", tokenSecret: "t" } });
    expect(() => attachSql(bearer.catalog, bearer.engine)).toThrow(
      /without authentication/,
    );
  });
});
