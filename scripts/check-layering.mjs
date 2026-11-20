import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

let failed = false;

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) {
      await checkDirectory(path);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node) {
        const isModuleSpecifier =
          node.parent &&
          (ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent)) &&
          node.parent.moduleSpecifier === node;
        const isDynamicImport =
          node.parent &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (
          (ts.isStringLiteral(node) &&
            node.text.startsWith("node:") &&
            (isModuleSpecifier || isDynamicImport)) ||
          (ts.isIdentifier(node) &&
            (node.text === "Buffer" || node.text === "process"))
        ) {
          const { line, character } = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          console.error(
            `${path}:${line + 1}:${character + 1}: forbidden Node API ${node.getText(source)}`,
          );
          failed = true;
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}

for (const name of ["core", "http"])
  await checkDirectory(join("packages", name));
if (failed) process.exitCode = 1;
