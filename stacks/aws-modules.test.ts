import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveDeployment, isOutputRef, type OutputType } from "@errtraq/core";
import { describe, expect, it } from "vitest";
import stack from "./aws-dynamodb.js";
import perTopic from "./aws-dynamodb-per-topic.js";

function typeName(type: OutputType): string {
  return typeof type === "string" ? type : `map(${typeName(type.map)})`;
}
function references(value: unknown): { name: string; path: string[] }[] {
  if (isOutputRef(value))
    return [{ name: value.name, path: [...(value.path ?? [])] }];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(references);
}
function matches(pattern: string, path: string[]): boolean {
  const parts = pattern.split(".");
  return (
    parts.length === path.length &&
    parts.every((part, i) => part === "*" || part === path[i])
  );
}

describe("AWS module descriptor contracts", () => {
  for (const selectedStack of [stack, perTopic]) {
    const view = deriveDeployment(selectedStack);
    it(`${selectedStack.name}: passes a physical-queue map to SQS`, () => {
      const inputs = selectedStack.queue.infra.inputs(
        selectedStack.queue.config,
        view,
      );
      expect(inputs.physical_queues).toEqual(
        Object.fromEntries(
          (selectedStack === stack ? ["shared"] : ["ingest"]).map((key) => [
            key,
            {
              visibility_timeout_sec: 180,
              dlq_enabled: true,
              max_receive_count: 5,
            },
          ]),
        ),
      );
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
        const outputSource = readFileSync(
          resolve(directory, "outputs.tf"),
          "utf8",
        );
        const declarationsByName = new Map(
          [...outputSource.matchAll(/^output "([^"]+)" \{([\s\S]*?)^\}/gm)].map(
            (m) => [m[1], m[2]],
          ),
        );
        const related = [
          selectedStack.platform,
          selectedStack.store,
          selectedStack.queue,
          selectedStack.blob,
          selectedStack.kv,
        ].filter(
          (item) =>
            item.infra.module.provider === module.provider &&
            item.infra.module.component === module.component,
        );
        const refs = references(
          related.map((item) => [
            item.infra.resources,
            item.infra.capabilities,
            item.infra.bindings,
          ]),
        );
        for (const [name, type] of Object.entries(module.outputs)) {
          const body = declarationsByName.get(name) ?? "";
          const contract =
            /description\s*=\s*"errtraq-type=([^;]+); errtraq-keys=([^;"]*); [^"]+"/.exec(
              body,
            );
          expect(contract?.[1], `${name} output type`).toBe(typeName(type));
          const patterns = contract?.[2] ? contract[2].split(",") : [];
          const paths = refs
            .filter((ref) => ref.name === name && ref.path.length > 0)
            .map((ref) => ref.path);
          for (const path of paths)
            expect(
              patterns.some((pattern) => matches(pattern, path)),
              `${name}.${path.join(".")}`,
            ).toBe(true);
          for (const pattern of patterns)
            expect(
              paths.some((path) => matches(pattern, path)),
              `${name}.${pattern}`,
            ).toBe(true);
        }
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
