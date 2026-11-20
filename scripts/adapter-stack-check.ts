import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect } from "vitest";
import {
  type AdapterSelection,
  type StackConfig,
  validateStack,
} from "../packages/core/src/index.js";

/** Check a selection in a complete stack and follow its local import graph. */
export async function assertStackHelper(
  selection: AdapterSelection,
  stackUrl: URL,
): Promise<void> {
  const schema = selection.manifest.configSchema;
  const dummy = (
    kind: "store" | "queue" | "blob" | "kv",
  ): AdapterSelection => ({
    manifest: {
      id: `dummy-${kind}`,
      kind,
      configSchema: schema,
      runtimes: ["node"],
      capabilities:
        kind === "store"
          ? {
              textSearch: false,
              lastSeenRangeOnOtherSort: false,
              deleteStrategy: "explicit",
            }
          : kind === "queue"
            ? { delivery: "pull", maxBytes: 100, delay: true, dlq: false }
            : {},
    },
    config: selection.config,
    infra: {
      module: `local/${kind}`,
      inputs: () => ({}),
      bindings: {},
      grants: [],
      triggers: [],
    },
    runtimeModule: `dummy-${kind}`,
  });
  const platform = {
    ...dummy("kv"),
    manifest: {
      ...dummy("kv").manifest,
      id: "platform",
      kind: "platform" as const,
      runtime: "node",
      compute: "long-lived" as const,
      functions: ["ingest", "api", "consumer", "cron"] as Array<
        "ingest" | "api" | "consumer" | "cron"
      >,
    },
  };
  const stack: StackConfig = {
    name: "test",
    platform,
    store: selection.manifest.kind === "store" ? selection : dummy("store"),
    queue: selection.manifest.kind === "queue" ? selection : dummy("queue"),
    blob: selection.manifest.kind === "blob" ? selection : dummy("blob"),
    kv: selection.manifest.kind === "kv" ? selection : dummy("kv"),
  };
  expect(validateStack(stack)).toEqual([]);
  const stackPath = fileURLToPath(stackUrl);
  const runtimePath = resolve(dirname(stackPath), "index.ts");
  async function graph(
    path: string,
    visited: Set<string>,
    stop?: string,
    stackGraph = false,
  ): Promise<void> {
    if (visited.has(path) || path === stop) return;
    visited.add(path);
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges: string[] = [];
    function visit(node: ts.Node) {
      if (
        stackGraph &&
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        (node.moduleSpecifier.text === selection.runtimeModule ||
          node.moduleSpecifier.text.startsWith(`${selection.runtimeModule}/`))
      )
        throw new Error("Stack imports runtime package");
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      )
        edges.push(node.moduleSpecifier.text);
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      )
        edges.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        throw new Error("Dynamic import in stack graph");
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const edge of edges)
      await graph(
        resolve(dirname(path), edge.replace(/\.js$/, ".ts")),
        visited,
        stop,
        stackGraph,
      );
  }
  const runtime = new Set<string>();
  await graph(runtimePath, runtime, stackPath);
  const actual = new Set<string>();
  await graph(stackPath, actual, undefined, true);
  expect([...actual].filter((path) => runtime.has(path))).toEqual([]);
}
