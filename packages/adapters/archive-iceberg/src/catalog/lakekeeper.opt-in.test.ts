// Opt-in: runs the catalog client against the M4d Lakekeeper (+ winterbaume) environment.
//
//   export WINTERBAUME_BINARY=<linux winterbaume-server>   # see scripts/archive-local/smoke.mjs
//   docker compose -p errtraq-archive -f docker/archive/compose.yaml \
//     -f docker/archive/compose.ports.yaml up -d --build --wait
//   docker compose -p errtraq-archive -f docker/archive/compose.yaml exec -T runner node bootstrap.mjs
//   ERRTRAQ_LAKEKEEPER_URL=http://127.0.0.1:18181/catalog pnpm exec vitest run lakekeeper.opt-in
//   docker compose -p errtraq-archive -f docker/archive/compose.yaml down -v
//
// ERRTRAQ_LAKEKEEPER_WAREHOUSE defaults to `errtraq` (the name bootstrap.mjs creates). Without
// ERRTRAQ_LAKEKEEPER_URL every case is skipped, so the default `pnpm test` stays offline.
import { describe, expect, it } from "vitest";
import {
  CatalogAlreadyExistsError,
  CatalogCommitConflictError,
  CatalogNotFoundError,
  IcebergRestCatalog,
} from "./index.js";

const uri = process.env.ERRTRAQ_LAKEKEEPER_URL;
const warehouse = process.env.ERRTRAQ_LAKEKEEPER_WAREHOUSE ?? "errtraq";

describe.skipIf(!uri)("IcebergRestCatalog against Lakekeeper", () => {
  const namespace = `m4e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const catalog = new IcebergRestCatalog({ uri: uri ?? "", warehouse });
  const schema = {
    type: "struct",
    "schema-id": 0,
    fields: [
      { id: 1, name: "event_id", required: true, type: "string" },
      { id: 2, name: "received_at", required: true, type: "timestamptz" },
    ],
  };

  it("returns the config with a prefix", async () => {
    const config = await catalog.getConfig();
    expect(await catalog.prefix()).toBeTruthy();
    expect(config.defaults).toBeTypeOf("object");
  });

  it("creates a namespace once and reports a second create", async () => {
    expect(await catalog.createNamespace([namespace])).toEqual({
      created: true,
    });
    await expect(catalog.createNamespace([namespace])).rejects.toBeInstanceOf(
      CatalogAlreadyExistsError,
    );
    expect(
      await catalog.createNamespace([namespace], {}, { ifNotExists: true }),
    ).toEqual({
      created: false,
    });
  });

  it("creates, loads and commits properties to a table", async () => {
    await expect(
      catalog.loadTable([namespace], "events"),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
    const created = await catalog.createTable([namespace], {
      name: "events",
      schema,
      properties: { "format-version": "2" },
    });
    const uuid = created.metadata["table-uuid"];
    expect(uuid).toBeTruthy();
    const loaded = await catalog.loadTable([namespace], "events");
    expect(loaded.metadata["table-uuid"]).toBe(uuid);
    expect(loaded.metadata["format-version"]).toBe(2);

    const committed = await catalog.commit([namespace], "events", {
      requirements: [{ type: "assert-table-uuid", uuid }],
      updates: [
        {
          action: "set-properties",
          updates: { "write.delete.mode": "merge-on-read" },
        },
      ],
    });
    expect(committed.metadata.properties?.["write.delete.mode"]).toBe(
      "merge-on-read",
    );
    const reloaded = await catalog.loadTable([namespace], "events");
    expect(reloaded.metadata.properties?.["write.delete.mode"]).toBe(
      "merge-on-read",
    );
  });

  it("maps a failed requirement to the retryable commit conflict", async () => {
    const error = await catalog
      .commit([namespace], "events", {
        // The table has no snapshots, so asserting that `main` points at one cannot hold.
        requirements: [
          {
            type: "assert-ref-snapshot-id",
            ref: "main",
            "snapshot-id": "4611686018427387904",
          },
        ],
        updates: [{ action: "set-properties", updates: { x: "y" } }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogCommitConflictError);
    expect((error as CatalogCommitConflictError).retryable).toBe(true);
  });
});
