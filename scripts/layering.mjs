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
export function findLayeringViolations(
  program,
  source,
  packageNames = {},
  options = {},
) {
  const checker = program.getTypeChecker();
  const violations = [];
  const path = source.fileName.replaceAll("\\", "/");
  const coreRestricted =
    /(?:^|\/)packages\/(?:core|http)\//.test(path) || path === "fixture.ts";
  const restricted = coreRestricted || options.workers === true;
  const adapter = path.match(/(?:^|\/)packages\/adapters\/([^/]+)\//)?.[1];
  const platform = path.match(/(?:^|\/)packages\/platforms\/([^/]+)\//)?.[1];
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
          specifier === "@moriyoshi/errtraq-core" ||
          (!coreRestricted &&
            options.workers &&
            (specifier.startsWith("@moriyoshi/errtraq-core/") ||
              specifier === "@moriyoshi/errtraq-aws-signing" ||
              specifier === "aws4fetch" ||
              specifier === "fast-xml-parser")) ||
          (specifier === "vitest" && /\.test\.[cm]?[jt]sx?$/.test(path))
        ))
    )
      report(node);
    const target = bare
      ? Object.entries(packageNames).find(
          ([name]) => specifier === name || specifier.startsWith(`${name}/`),
        )?.[1]
      : resolve(dirname(source.fileName), specifier).split(sep).join("/");
    const platformTarget = target?.match(
      /(?:^|\/)packages\/platforms\/([^/]+)(?:\/|$)/,
    )?.[1];
    if (platformTarget && platformTarget !== platform) report(node);
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
        options.workers &&
        path.endsWith("worker-bundle.mjs") &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "__require"
      )
        report(node);
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

/** Traverse runtime value imports in workspace sources, excluding type-only references and tests. */
export function workersReachable(program, entries) {
  const byPath = new Map(
    program
      .getSourceFiles()
      .map((source) => [resolve(source.fileName), source]),
  );
  const visited = new Set();
  const queue = entries.map((entry) => resolve(entry));
  while (queue.length) {
    const name = queue.pop();
    if (visited.has(name)) continue;
    const source = byPath.get(name);
    if (!source) throw new Error(`Workers runtime source not found: ${name}`);
    visited.add(name);
    const add = (specifier) => {
      const found = ts.resolveModuleName(
        specifier,
        source.fileName,
        program.getCompilerOptions(),
        ts.sys,
      ).resolvedModule;
      if (!found) return;
      const target = resolve(found.resolvedFileName);
      if (
        !target.includes(`${sep}node_modules${sep}`) &&
        byPath.has(target) &&
        !/\.test\.[cm]?[jt]sx?$/.test(target)
      )
        queue.push(target);
    };
    const visit = (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        !node.importClause?.isTypeOnly
      ) {
        const bindings = node.importClause?.namedBindings;
        const onlyTypes =
          !node.importClause?.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.every((item) => item.isTypeOnly);
        if (!onlyTypes) add(node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        !node.isTypeOnly
      )
        add(node.moduleSpecifier.text);
      else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return visited;
}
