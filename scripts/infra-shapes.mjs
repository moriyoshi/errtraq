import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const snapshotPath = resolve("infra/modules/aws/output-shapes.json");
export const captureRuns = {
  dynamodb: "store_indexes_and_permissions",
  "lambda-app": "functions_triggers_and_urls",
  s3: "policies_and_lifecycle",
  sqs: "queues_and_policies",
};
export function shape(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return "json-document";
    } catch {
      /* plain strings are not JSON documents */
    }
    return "string";
  }
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape(value[key])]),
    );
  return value === null ? "null" : typeof value;
}
export function capturedShape(output, component) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event.type !== "test_state" ||
      event["@testrun"] !== captureRuns[component]
    )
      continue;
    return shape(
      Object.fromEntries(
        Object.entries(event.test_state.outputs).map(([key, data]) => [
          key,
          data.value,
        ]),
      ),
    );
  }
  throw new Error(`No mock-provider output captured for ${component}`);
}
export function checkShape(component, value) {
  const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
  deepStrictEqual(
    value,
    expected[component],
    `${component} mock output shape differs from snapshot`,
  );
}

/** Copy only the provider and first successful apply run for compact verbose output. */
export function shapeFixture(source) {
  function block(start) {
    const begin = source.indexOf("{", start);
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let i = begin; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error("Unterminated Terraform test block");
  }
  const provider = source.search(/^mock_provider\s+"aws"/m);
  const run = source.search(/^run\s+"/m);
  if (provider < 0 || run < 0) throw new Error("Missing mock provider or run");
  let runBlock = block(run);
  const assertions = [...runBlock.matchAll(/^\s*assert\s*\{/gm)]
    .map((match) => match.index ?? 0)
    .reverse();
  for (const index of assertions) {
    const original = source;
    source = runBlock;
    const assertion = block(index);
    source = original;
    runBlock =
      runBlock.slice(0, index) + runBlock.slice(index + assertion.length);
  }
  return `${block(provider)}\n${runBlock}\n`;
}
