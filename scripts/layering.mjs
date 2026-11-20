import { builtinModules } from "node:module";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";

const builtins = new Set(builtinModules.map((s) => s.replace(/^node:/, "")));
const forbidden = new Set([
  "process",
  "Buffer",
  "global",
  "__dirname",
  "__filename",
  "setImmediate",
  "clearImmediate",
  "require",
  "createRequire",
]);

/** Enforce Workers globals and workspace import boundaries. */
export function findLayeringViolations(program, source, packageNames = {}) {
  const checker = program.getTypeChecker();
  const violations = [];
  const path = source.fileName.replaceAll("\\", "/");
  const restricted =
    /(?:^|\/)packages\/(?:core|http)\//.test(path) || path === "fixture.ts";
  const adapter = path.match(/(?:^|\/)packages\/adapters\/([^/]+)\//)?.[1];
  const aliases = new Set();
  function report(node) {
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    violations.push(
      `${source.fileName}:${line + 1}:${character + 1}: forbidden dependency or Node API ${node.getText(source)}`,
    );
  }
  function checkModule(node) {
    if (!ts.isStringLiteralLike(node)) {
      if (restricted) report(node);
      return;
    }
    const specifier = node.text;
    const bare = !specifier.startsWith(".") && !specifier.startsWith("/");
    if (
      restricted &&
      bare &&
      (builtins.has(specifier.replace(/^node:/, "")) ||
        !(
          specifier === "zod" ||
          specifier === "hono" ||
          specifier.startsWith("hono/") ||
          specifier === "@errtraq/core" ||
          (specifier === "vitest" && /\.test\.[cm]?[jt]sx?$/.test(path))
        ))
    )
      report(node);
    const target = bare
      ? Object.entries(packageNames).find(
          ([name]) => specifier === name || specifier.startsWith(`${name}/`),
        )?.[1]
      : resolve(dirname(source.fileName), specifier).split(sep).join("/");
    if (target && /(?:^|\/)packages\/platforms(?:\/|$)/.test(target))
      report(node);
    if (adapter && target) {
      const dest = target.match(/(?:^|\/)packages\/adapters\/([^/]+)/)?.[1];
      if (dest && dest !== adapter) report(node);
    }
  }
  function visit(node) {
    const parent = node.parent;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      (node.initializer.text === "globalThis" ||
        aliases.has(node.initializer.text))
    )
      aliases.add(node.name.text);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      checkModule(node.moduleSpecifier);
    if (ts.isExternalModuleReference(node) && node.expression)
      checkModule(node.expression);
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0]
      )
        checkModule(node.arguments[0]);
      if (
        restricted &&
        ts.isIdentifier(node.expression) &&
        ["require", "createRequire"].includes(node.expression.text)
      )
        report(node.expression);
    }
    if (
      restricted &&
      ts.isIdentifier(node) &&
      forbidden.has(node.text) &&
      parent
    ) {
      const property =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent)) &&
          parent.name === node);
      const globalProperty =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        ts.isIdentifier(parent.expression) &&
        (parent.expression.text === "globalThis" ||
          aliases.has(parent.expression.text));
      const local = checker
        .getSymbolAtLocation(node)
        ?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile);
      const called =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        ["require", "createRequire"].includes(node.text);
      if (
        !called &&
        (globalProperty || (!property && !ts.isDeclarationName(node) && !local))
      )
        report(node);
    }
    if (
      restricted &&
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "globalThis" ||
        aliases.has(node.expression.text)) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      forbidden.has(node.argumentExpression.text)
    )
      report(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}
