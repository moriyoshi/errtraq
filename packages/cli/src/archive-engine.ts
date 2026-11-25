import type { AdapterSelection } from "@moriyoshi/errtraq-core";

/**
 * Runtime bindings the CLI supplies to the archive adapter: the DuckDB engine. The subpath is
 * imported here (Node only) and only when the stack selects `archive-iceberg`, so commands and
 * bundles without an archive never load the native binding.
 */
export async function archiveBindings(
  selection: AdapterSelection,
): Promise<Record<string, unknown>> {
  if (selection.manifest.id !== "archive-iceberg") return {};
  const duckdb = await import("@moriyoshi/errtraq-archive-iceberg/duckdb");
  return { createEngine: duckdb.create };
}

/** Anything with `ensureTable` (the DuckDB-backed archive store) can be bootstrapped. */
export function hasEnsureTable(
  value: unknown,
): value is { ensureTable(): Promise<{ created: boolean }> } {
  return (
    !!value &&
    typeof value === "object" &&
    "ensureTable" in value &&
    typeof value.ensureTable === "function"
  );
}
