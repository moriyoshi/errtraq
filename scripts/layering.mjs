import ts from "typescript";

/** Inspect references with a type checker so local bindings can shadow Node globals. */
export function findLayeringViolations(program, source) {
  const checker = program.getTypeChecker();
  const violations = [];
  function report(node) {
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    violations.push(
      `${source.fileName}:${line + 1}:${character + 1}: forbidden Node API ${node.getText(source)}`,
    );
  }
  function visit(node) {
    const parent = node.parent;
    if (
      ts.isStringLiteralLike(node) &&
      node.text.startsWith("node:") &&
      parent &&
      (((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        parent.moduleSpecifier === node) ||
        (ts.isCallExpression(parent) &&
          parent.expression.kind === ts.SyntaxKind.ImportKeyword) ||
        ts.isExternalModuleReference(parent))
    )
      report(node);
    if (
      ts.isIdentifier(node) &&
      (node.text === "Buffer" || node.text === "process") &&
      parent
    ) {
      const propertyName =
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
        parent.expression.text === "globalThis";
      const symbol = checker.getSymbolAtLocation(node);
      const local = symbol?.declarations?.some(
        (declaration) => !declaration.getSourceFile().isDeclarationFile,
      );
      if (
        globalProperty ||
        (!propertyName && !ts.isDeclarationName(node) && !local)
      )
        report(node);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      ["Buffer", "process"].includes(node.argumentExpression.text)
    )
      report(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}
