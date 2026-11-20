import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveDeployment } from "@errtraq/core";
import { describe, expect, it } from "vitest";
import stack from "./aws-dynamodb.js";
import perTopic from "./aws-dynamodb-per-topic.js";

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
          (selectedStack === stack
            ? ["shared"]
            : ["ingest", "archive_project", "notifications"]
          ).map((key) => [
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
          expect(module.outputs.policies).toEqual({ map: { map: "string" } });
        }
        expect(
          Object.keys(inputs).filter((name) => !variables.includes(name)),
        ).toEqual([]);
      });
    }
  }
});
