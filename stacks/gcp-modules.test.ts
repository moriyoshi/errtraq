import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isOutputRef,
  type OutputType,
  type ResolvedStack,
} from "@moriyoshi/errtraq-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = {
  ERRTRAQ_GCP_PROJECT: "example-project",
  ERRTRAQ_GCP_REGION: "europe-west1",
  ERRTRAQ_GCP_SQL_INSTANCE: "example-sql",
};
const stacks = {
  "gcp-firestore": () => import("./gcp-firestore.js"),
  "gcp-cloudsql": () => import("./gcp-cloudsql.js"),
};
afterEach(() => vi.unstubAllEnvs());

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
  readFileSync(resolve("infra/modules/google/output-shapes.json"), "utf8"),
);
/** The attributes of an object-typed variable: name and whether it is optional. */
function objectAttributes(variables: string, variable: string) {
  const start = variables.indexOf(`variable "${variable}"`);
  const body = variables.slice(start, variables.indexOf("\nvariable ", start));
  const type = body.slice(body.indexOf("type"), body.indexOf("validation"));
  return [...type.matchAll(/^ {4}(\w+)\s*=\s*(optional\()?/gm)].map(
    (match) => ({
      name: match[1] ?? "",
      optional: match[2] !== undefined,
    }),
  );
}

describe.each(Object.keys(stacks) as (keyof typeof stacks)[])(
  "Google module descriptor contracts: %s",
  (name) => {
    async function load() {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.resetModules();
      // The stack and the derivation must come from the same module graph.
      const core = await import("@moriyoshi/errtraq-core");
      return {
        stack: (await stacks[name]()).default as ResolvedStack,
        deriveDeployment: core.deriveDeployment,
      };
    }
    it("declares exactly its HCL outputs and supplies only declared variables", async () => {
      const { stack, deriveDeployment } = await load();
      const view = deriveDeployment(stack);
      for (const selection of [
        stack.platform,
        stack.store,
        stack.queue,
        stack.blob,
        stack.kv,
      ]) {
        const module = selection.infra.module;
        expect(module.provider).toBe("google");
        const directory = resolve(
          "infra/modules",
          module.provider,
          module.component,
        );
        const source = readdirSync(directory)
          .filter((file) => file.endsWith(".tf"))
          .map((file) => readFileSync(resolve(directory, file), "utf8"))
          .join("\n");
        const outputs = [
          ...source.matchAll(/^output\s+"([a-zA-Z0-9_]+)"\s*\{/gm),
        ]
          .map((match) => match[1])
          .sort();
        const variables = [
          ...source.matchAll(/^variable\s+"([a-zA-Z0-9_]+)"\s*\{/gm),
        ].map((match) => match[1]);
        expect(outputs, module.component).toEqual(
          Object.keys(module.outputs).sort(),
        );
        const actual = atPath(shapes, [module.component]);
        expect(actual, `${module.component} output snapshot`).toBeTruthy();
        for (const [output, type] of Object.entries(module.outputs))
          assertType(
            atPath(actual, [output]),
            type,
            `${module.component}.${output}`,
          );
        for (const ref of references([
          selection.infra.resources,
          selection.infra.capabilities,
          selection.infra.bindings,
        ]))
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
          const variable = declaration[1] ?? "";
          const body = declaration[2] ?? "";
          expect(body, variable).toMatch(/\btype\s*=/);
          expect(body, variable).toMatch(/\bdescription\s*=/);
          if (!(variable in inputs))
            expect(body, variable).toMatch(/\bdefault\s*=/);
        }
        expect(declarations).toHaveLength(variables.length);
        if ("policies" in module.outputs)
          expect(module.outputs.policies).toEqual({
            map: { map: "json-document" },
          });
        expect(
          Object.keys(inputs).filter((input) => !variables.includes(input)),
        ).toEqual([]);
      }
    });
    it("supplies every attribute the platform module's object variables declare, and no other", async () => {
      const { stack, deriveDeployment } = await load();
      const view = deriveDeployment(stack);
      const inputs = stack.platform.infra.inputs(stack.platform.config, view);
      const variables = readFileSync(
        resolve("infra/modules/google/cloud-run-app/variables.tf"),
        "utf8",
      );
      for (const variable of ["functions", "queue_triggers", "cron_triggers"]) {
        const declared = objectAttributes(variables, variable);
        expect(declared.length, variable).toBeGreaterThan(3);
        const supplied = inputs[variable];
        expect(supplied && typeof supplied === "object", variable).toBe(true);
        for (const [key, entry] of Object.entries(supplied ?? {})) {
          const names = Object.keys(entry as object);
          expect(
            names.filter((item) => !declared.some((d) => d.name === item)),
            `${variable}.${key} supplies an undeclared attribute`,
          ).toEqual([]);
          expect(
            declared
              .filter((d) => !d.optional && !names.includes(d.name))
              .map((d) => d.name),
            `${variable}.${key} lacks a required attribute`,
          ).toEqual([]);
        }
      }
      const physical = stack.queue.infra.inputs(stack.queue.config, view);
      const declared = objectAttributes(
        readFileSync(
          resolve("infra/modules/google/pubsub/variables.tf"),
          "utf8",
        ),
        "physical_queues",
      );
      for (const entry of Object.values(
        physical.physical_queues as Record<string, object>,
      )) {
        expect(
          Object.keys(entry).filter(
            (item) => !declared.some((d) => d.name === item),
          ),
        ).toEqual([]);
        expect(
          declared
            .filter((d) => !d.optional && !(d.name in entry))
            .map((d) => d.name),
        ).toEqual([]);
      }
    });
    it("names topics and subscriptions as the pubsub module reserves them", async () => {
      const { stack, deriveDeployment } = await load();
      const view = deriveDeployment(stack);
      const main = readFileSync(
        resolve("infra/modules/google/pubsub/main.tf"),
        "utf8",
      );
      // The platform module derives the topic and dead-letter topic from the subscription name.
      expect(main).toContain(`name     = "\${var.name}-\${each.key}"`);
      expect(main).toContain(`name     = "\${var.name}-\${each.key}-dlq"`);
      expect(main).toContain(
        `subscription     = "projects/\${topic.project}/subscriptions/\${topic.name}"`,
      );
      const triggers = view.triggers.filter((item) => item.kind === "queue");
      expect(triggers.length).toBeGreaterThan(0);
      for (const trigger of triggers)
        expect(JSON.stringify(trigger.resource)).toContain("subscription");
    });
  },
);
