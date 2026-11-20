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

/** Stack helpers may import only local files and the explicitly safe package APIs. */
export async function assertSafeStackImports(stackUrl: URL): Promise<void> {
  const visited = new Set<string>();
  async function visitFile(path: string): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges: string[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        throw new Error("Dynamic import in stack graph");
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith(".")) edges.push(specifier);
        else if (specifier !== "zod" && specifier !== "@errtraq/core")
          throw new Error(`Forbidden stack package import: ${specifier}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const edge of edges)
      await visitFile(resolve(dirname(path), edge.replace(/\.js$/, ".ts")));
  }
  await visitFile(fileURLToPath(stackUrl));
}

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
      module: { provider: "local", component: kind, outputs: {} },
      inputs: () => ({}),
      bindings: [],
      capabilities: {},
      grants: [],
      ...(kind === "queue"
        ? {
            topics: {
              mode: "shared" as const,
              routes: {
                ingest: {
                  physical: "memory",
                  producers: ["ingest" as const],
                  consumer: "consumer" as const,
                  resource: "memory",
                },
                "archive.project": {
                  physical: "memory",
                  producers: ["cron" as const],
                  consumer: "consumer" as const,
                  resource: "memory",
                },
                notifications: {
                  physical: "memory",
                  producers: ["consumer" as const],
                  consumer: "consumer" as const,
                  resource: "memory",
                },
              },
            },
          }
        : {}),
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
      configSchema: schema.transform(() => ({
        roles: ["ingest", "api", "consumer", "cron"],
        split: [],
        cron: [],
      })),
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
  await assertSafeStackImports(stackUrl);
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
