// Runs the generated SQL against an in-memory DuckDB (no Iceberg, no catalog) to check that the
// statements parse and bind and that the row mapping round-trips. Skipped when the native
// `@duckdb/node-api` binding cannot be loaded (for example before it is installed on the host).
import type {
  Day,
  EventId,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendStatement,
  batchEventIdsStatement,
  EVENT_COLUMNS,
  getEventStatement,
  hasBatchStatement,
  queryStatement,
} from "./sql.js";

type Duck = typeof import("@duckdb/node-api");
const duck: Duck | undefined = await import("@duckdb/node-api").catch(
  () => undefined,
);

const project = "p1" as ProjectId;
const at = (iso: string) => iso as Timestamp;
const event = (
  id: string,
  receivedAt: string,
  extra: Partial<StoredEvent> = {},
): StoredEvent => ({
  projectId: project,
  eventId: id as EventId,
  issueId: "i1" as StoredEvent["issueId"],
  timestamp: at(receivedAt),
  receivedAt: at(receivedAt),
  level: "error",
  tags: { a: "b" },
  payload: { id, text: 'it\'s "quoted" \\ é' },
  ...extra,
});

describe.skipIf(!duck)("generated SQL on in-memory DuckDB", () => {
  let instance: Awaited<ReturnType<Duck["DuckDBInstance"]["create"]>>;
  let connection: Awaited<ReturnType<typeof instance.connect>>;
  const all = async (sql: string, params: readonly unknown[] = []) =>
    (
      await connection.runAndReadAll(
        sql,
        params.length ? ([...params] as never) : undefined,
      )
    ).getRowObjectsJson();
  const run = (statement: { sql: string; params: unknown[] }) =>
    all(statement.sql, statement.params);

  beforeAll(async () => {
    instance = await (duck as Duck).DuckDBInstance.create(":memory:");
    connection = await instance.connect();
    await all("ATTACH ':memory:' AS lake");
    await all('CREATE SCHEMA lake."errtraq"');
    const columns = EVENT_COLUMNS.map(([n, t]) => `"${n}" ${t}`).join(", ");
    await all(`CREATE TABLE lake."errtraq"."events" (${columns})`);
    await run(
      appendStatement("errtraq", "b1", [
        event("e2", "2024-03-01T10:00:00.000Z", {
          user: { email: "x'); DROP TABLE events; --" },
        }),
        event("e1", "2024-03-01T10:00:00.000Z"),
        event("e3", "2024-03-02T10:00:00.123Z", {
          issueId: "i2" as StoredEvent["issueId"],
          tags: {},
        }),
      ]),
    );
    await run(
      appendStatement("errtraq", "b2", [
        event("e9", "2024-03-05T00:00:00.000Z", {
          projectId: "p2" as ProjectId,
        }),
      ]),
    );
  });
  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
  });

  const days = (a: string, b: string): [Day, Day] => [a as Day, b as Day];

  it("stores promoted columns and the event JSON", async () => {
    const rows = await all(
      'SELECT user_email, CAST(tags AS VARCHAR) AS tags, CAST(epoch_us(received_at) AS VARCHAR) AS r FROM lake."errtraq"."events" WHERE event_id = ?',
      ["e3"],
    );
    expect(rows[0]?.tags).toBe("{}");
    expect(rows[0]?.r).toBe(
      String(Date.parse("2024-03-02T10:00:00.123Z") * 1000),
    );
    expect(
      (
        await all(
          'SELECT user_email FROM lake."errtraq"."events" WHERE event_id = ?',
          ["e2"],
        )
      )[0]?.user_email,
    ).toBe("x'); DROP TABLE events; --");
  });

  it("probes batches pruned by day range", async () => {
    expect(
      await run(
        hasBatchStatement("errtraq", "b1", days("2024-03-01", "2024-03-02")),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        hasBatchStatement("errtraq", "b1", days("2024-03-02", "2024-03-02")),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        hasBatchStatement("errtraq", "b1", days("2024-03-03", "2024-03-09")),
      ),
    ).toHaveLength(0);
    expect(
      await run(
        hasBatchStatement("errtraq", "nope", days("2024-03-01", "2024-03-02")),
      ),
    ).toHaveLength(0);
    expect(
      (
        await run(
          batchEventIdsStatement(
            "errtraq",
            project,
            "b1",
            days("2024-03-01", "2024-03-02"),
          ),
        )
      ).map((r) => r.event_id),
    ).toEqual(["e1", "e2", "e3"]);
    expect(
      await run(
        batchEventIdsStatement(
          "errtraq",
          project,
          "b2",
          days("2024-03-01", "2024-03-09"),
        ),
      ),
    ).toEqual([]);
  });

  it("pages in both directions with the (received_at, event_id) keyset", async () => {
    const ids = async (
      query: Parameters<typeof queryStatement>[1],
      after?: { receivedAt: Timestamp; eventId: EventId },
      limit = 10,
    ) =>
      (await run(queryStatement("errtraq", query, after, limit))).map(
        (r) => (JSON.parse(String(r.event)) as StoredEvent).eventId,
      );
    expect(await ids({ projectId: project, order: "asc" })).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(await ids({ projectId: project })).toEqual(["e3", "e2", "e1"]);
    expect(
      await ids(
        { projectId: project, order: "asc" },
        {
          receivedAt: at("2024-03-01T10:00:00.000Z"),
          eventId: "e1" as EventId,
        },
      ),
    ).toEqual(["e2", "e3"]);
    expect(
      await ids(
        { projectId: project },
        {
          receivedAt: at("2024-03-01T10:00:00.000Z"),
          eventId: "e2" as EventId,
        },
      ),
    ).toEqual(["e1"]);
    expect(
      await ids({
        projectId: project,
        issueId: "i2" as StoredEvent["issueId"],
      }),
    ).toEqual(["e3"]);
    expect(
      await ids({
        projectId: project,
        from: at("2024-03-02T00:00:00.000Z"),
        to: at("2024-03-03T00:00:00.000Z"),
      }),
    ).toEqual(["e3"]);
    expect(
      await ids({ projectId: project, order: "asc" }, undefined, 2),
    ).toHaveLength(3);
  });

  it("returns the stored event unchanged and isolates projects", async () => {
    const row = (
      await run(
        getEventStatement(
          "errtraq",
          project,
          "e1" as EventId,
          "2024-03-01" as Day,
        ),
      )
    )[0];
    expect(JSON.parse(String(row?.event))).toEqual(
      event("e1", "2024-03-01T10:00:00.000Z"),
    );
    expect(
      await run(getEventStatement("errtraq", project, "e9" as EventId)),
    ).toEqual([]);
    expect(
      await run(
        getEventStatement(
          "errtraq",
          project,
          "e1" as EventId,
          "2024-03-09" as Day,
        ),
      ),
    ).toEqual([]);
  });
});
