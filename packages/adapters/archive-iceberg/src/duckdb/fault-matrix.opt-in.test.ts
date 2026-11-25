// Opt-in: the M4b archival fault matrix against the real DuckDB engine, Lakekeeper and winterbaume,
// for the COMMIT boundary (`archive.append`, the `hasBatch` probe, `batchEventIds`) and the MARK
// boundary (every `meta.compareAndSetArchiveState`). Same environment as lakekeeper.opt-in.test.ts:
//
//   ERRTRAQ_LAKEKEEPER_URL=http://127.0.0.1:18181/catalog pnpm exec vitest run duckdb/fault-matrix.opt-in
//
// Every cell uses a fresh namespace (its own table), so batch ids never collide across cells.
import type { EventId, ProjectId, Timestamp } from "@moriyoshi/errtraq-core";
import {
  expectArchivedExactlyOnce,
  FaultInjector,
  InjectedFault,
  MemoryActiveStore,
  recover,
  scenario,
} from "@moriyoshi/errtraq-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { configSchema } from "../stack.js";
import { create } from "./index.js";
import type { DuckDbArchiveStore } from "./store.js";

const uri = process.env.ERRTRAQ_LAKEKEEPER_URL;
const duck = await import("@duckdb/node-api").catch(() => undefined);
const enabled = Boolean(uri && duck);

vi.setConfig({ testTimeout: 600_000, hookTimeout: 180_000 });

const warehouse = process.env.ERRTRAQ_LAKEKEEPER_WAREHOUSE ?? "errtraq";
const s3Endpoint = process.env.ERRTRAQ_ARCHIVE_S3_ENDPOINT ?? "127.0.0.1:15555";
const projectId = "1" as ProjectId;
const stores: DuckDbArchiveStore[] = [];
let counter = 0;

async function freshStore(): Promise<DuckDbArchiveStore> {
  const namespace = `m4g_${Date.now().toString(36)}_${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const store = create({
    config: configSchema.parse({
      catalog: { uri: uri ?? "", warehouse },
      namespace,
      engine: {
        homeDirectory:
          process.env.ERRTRAQ_DUCKDB_HOME ?? "/tmp/errtraq-duckdb-test",
        s3: {
          endpoint: s3Endpoint,
          urlStyle: "path",
          useSsl: false,
          region: "us-east-1",
        },
      },
    }),
    bindings: {},
    dependencies: {},
    environment: { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" },
  });
  stores.push(store);
  await store.ensureTable();
  return store;
}
/** One batch (two events, one with an overflow payload): the smallest run that has COMMIT and MARK. */
async function freshScenario() {
  return scenario(async () => new MemoryActiveStore(), {
    old: 2,
    overflowIndex: 1,
    maxRows: 2,
    archive: await freshStore(),
  });
}

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
});

describe.skipIf(!enabled)("archival fault matrix on the real engine", () => {
  it("survives a crash before and after every COMMIT and MARK operation", async () => {
    const dry = new FaultInjector();
    const probe = await freshScenario();
    await probe.worker({ faults: dry }).run(projectId);
    await expectArchivedExactlyOnce(
      probe,
      probe.fixture.old.map((e) => e.eventId),
    );
    const calls = dry.calls();
    const boundary = [
      "archive.append",
      "archive.batchEventIds",
      "meta.compareAndSetArchiveState",
    ];
    for (const op of boundary) expect(calls[op]).toBeGreaterThan(0);
    let cells = 0;
    for (const op of boundary)
      for (let nth = 1; nth <= (calls[op] ?? 0); nth++)
        for (const when of ["before", "after"] as const) {
          const label = `${op}#${nth} ${when}`;
          try {
            const s = await freshScenario();
            const faults = new FaultInjector().arm({ op, nth, when });
            await s
              .worker({ faults })
              .run(projectId)
              .catch((error: unknown) => {
                if (!(error instanceof InjectedFault)) throw error;
              });
            expect(faults.fired).toHaveLength(1);
            await recover(s, faults);
            await expectArchivedExactlyOnce(
              s,
              s.fixture.old.map((e) => e.eventId),
            );
            cells++;
          } catch (error) {
            throw new Error(`fault cell ${label}: ${String(error)}`, {
              cause: error,
            });
          }
        }
    console.log(`fault matrix on the real engine: ${cells} cells passed`);
  });

  it("probes hasBatch against the engine when it resumes a committing batch", async () => {
    for (const when of ["before", "after"] as const) {
      const s = await freshScenario();
      // the append took effect but the worker died before MARK: state is `committing`
      const first = new FaultInjector().arm({
        op: "archive.append",
        nth: 1,
        when: "after",
      });
      await expect(
        s.worker({ faults: first }).run(projectId),
      ).rejects.toBeInstanceOf(InjectedFault);
      expect(
        (await s.store.meta.getArchiveState(projectId))?.batch?.state,
      ).toBe("committing");
      const second = new FaultInjector().arm({
        op: "archive.hasBatch",
        nth: 1,
        when,
      });
      s.clock.advance(2 * 60_000 + 1);
      await expect(
        s.worker({ faults: second }).run(projectId),
      ).rejects.toBeInstanceOf(InjectedFault);
      expect(second.count("archive.hasBatch")).toBe(1);
      const third = new FaultInjector();
      await recover(s, third);
      // the real probe found the committed batch, so the recovery never appended it again
      expect(third.count("archive.hasBatch")).toBe(1);
      expect(third.count("archive.append")).toBe(0);
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
    }
  });

  it("abandons a committing batch the engine never saw and rebuilds it under the same id", async () => {
    const s = await freshScenario();
    const first = new FaultInjector().arm({
      op: "archive.append",
      nth: 1,
      when: "before",
    });
    await expect(
      s.worker({ faults: first }).run(projectId),
    ).rejects.toBeInstanceOf(InjectedFault);
    expect(
      (await s.store.meta.getArchiveState(projectId))?.batch,
    ).toMatchObject({ id: "1/0", state: "committing" });
    const late = await s.addOld(
      "late",
      new Date(
        Date.parse("2024-01-01T00:00:00.000Z") - 1000,
      ).toISOString() as Timestamp,
    );
    const probe = new FaultInjector();
    await recover(s, probe);
    expect(probe.count("archive.hasBatch")).toBe(1);
    await expectArchivedExactlyOnce(s, [
      late.eventId as EventId,
      ...s.fixture.old.map((e) => e.eventId),
    ]);
  });
});
