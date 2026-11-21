import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deriveDeployment,
  isOutputRef,
  type OutputType,
  resolveStack,
} from "@errtraq/core";
import { postgres } from "@errtraq/store-sql/postgres/stack";
import { describe, expect, it } from "vitest";
import stack from "./aws-dynamodb.js";
import perTopic from "./aws-dynamodb-per-topic.js";

function references(value: unknown): { name: string; path: string[] }[] {
  if (isOutputRef(value))
    return [{ name: value.name, path: [...(value.path ?? [])] }];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(references);
}
function assertType(value: unknown, type: OutputType, path: string): void {
  if (typeof type === "string") {
    if (type === "secret-ref") expect(value, path).toBe("string");
    else if (type === "string[]") {
      expect(Array.isArray(value), path).toBe(true);
      if (Array.isArray(value))
        for (const item of value) expect(item, path).toBe("string");
    } else if (type === "json") {
      expect(value, path).toBeTruthy();
      expect(typeof value, path).toBe("object");
    } else expect(value, path).toBe(type);
    return;
  }
  expect(value, path).toBeTruthy();
  expect(typeof value, path).toBe("object");
  expect(Array.isArray(value), path).toBe(false);
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value))
      assertType(child, type.map, `${path}.${key}`);
}
function atPath(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}
const shapes: unknown = JSON.parse(
  readFileSync(resolve("infra/modules/aws/output-shapes.json"), "utf8"),
);

const postgresStack = resolveStack({
  ...Object.fromEntries(Object.entries(stack)),
  store: postgres({
    mode: "iam",
    host: "db.example.rds.amazonaws.com",
    database: "errtraq",
    user: "app_user",
    region: "us-east-1",
    resourceId: "db-ABC123",
  }),
});
describe("AWS module descriptor contracts", () => {
  for (const selectedStack of [stack, perTopic, postgresStack]) {
    const view = deriveDeployment(selectedStack);
    it(`${selectedStack.name}: passes a physical-queue map to SQS`, () => {
      const inputs = selectedStack.queue.infra.inputs(
        selectedStack.queue.config,
        view,
      );
      expect(inputs.physical_queues).toEqual({
        ...Object.fromEntries(
          (selectedStack.queue.infra.topics?.mode === "shared"
            ? ["shared"]
            : ["ingest"]
          ).map((key) => [
            key,
            {
              visibility_timeout_sec: 180,
              dlq_enabled: true,
              max_receive_count: 5,
            },
          ]),
        ),
        record: {
          visibility_timeout_sec: 180,
          dlq_enabled: true,
          max_receive_count: 5,
          fifo: true,
        },
      });
    });
    for (const selection of [
      selectedStack.platform,
      selectedStack.store,
      selectedStack.queue,
      selectedStack.blob,
      selectedStack.kv,
    ]) {
      const module = selection.infra.module;
      const directory = resolve(
        "infra/modules",
        module.provider,
        module.component,
      );
      it(`${selectedStack.name}: ${selection.manifest.id} declares exactly its HCL outputs and supplies only declared variables`, () => {
        const source = readdirSync(directory)
          .filter((name) => name.endsWith(".tf"))
          .map((name) => readFileSync(resolve(directory, name), "utf8"))
          .join("\n");
        const outputs = [
          ...source.matchAll(/^output\s+"([a-zA-Z0-9_]+)"\s*\{/gm),
        ]
          .map((match) => match[1])
          .sort();
        const variables = [
          ...source.matchAll(/^variable\s+"([a-zA-Z0-9_]+)"\s*\{/gm),
        ].map((match) => match[1]);
        expect(outputs).toEqual(Object.keys(module.outputs).sort());
        const actual = atPath(shapes, [module.component]);
        expect(actual, `${module.component} output snapshot`).toBeTruthy();
        for (const [name, type] of Object.entries(module.outputs))
          assertType(
            atPath(actual, [name]),
            type,
            `${module.component}.${name}`,
          );
        const refs = references([
          selection.infra.resources,
          selection.infra.capabilities,
          selection.infra.bindings,
        ]);
        for (const ref of refs)
          expect(
            atPath(actual, [ref.name, ...ref.path]),
            `${module.component}.${[ref.name, ...ref.path].join(".")}`,
          ).toBeDefined();
        const inputs = selection.infra.inputs(selection.config, view);
        const variablesSource = readFileSync(
          resolve(directory, "variables.tf"),
          "utf8",
        );
        const declarations = [
          ...variablesSource.matchAll(
            /^variable\s+"([a-zA-Z0-9_]+)"\s*\{([\s\S]*?)(?=^variable\s+"|$(?![\s\S]))/gm,
          ),
        ];
        for (const declaration of declarations) {
          const name = declaration[1] ?? "";
          const body = declaration[2] ?? "";
          expect(body, name).toMatch(/\btype\s*=/);
          expect(body, name).toMatch(/\bdescription\s*=/);
          expect(body, name).toMatch(/\bvalidation\s*\{/);
          if (!(name in inputs)) expect(body, name).toMatch(/\bdefault\s*=/);
        }
        expect(declarations).toHaveLength(variables.length);
        if ("policies" in module.outputs) {
          expect(module.outputs.policies).toEqual({
            map: { map: "json-document" },
          });
        }
        expect(
          Object.keys(inputs).filter((name) => !variables.includes(name)),
        ).toEqual([]);
      });
    }
  }
});
