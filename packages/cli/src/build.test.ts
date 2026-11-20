import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  constructDeployedStack,
  deployedPlan,
  deriveDeployment,
} from "@errtraq/core";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import shared from "../../../stacks/aws-dynamodb.js";
import perTopic from "../../../stacks/aws-dynamodb-per-topic.js";
import local from "../../../stacks/local.js";
import { buildStack } from "./build.js";
import { generateInfra } from "./infra.js";
import { formatValidation } from "./validation.js";

const repo = process.cwd();
let temp: string;
beforeAll(async () => {
  temp = await mkdtemp(resolve(repo, ".agents-workspace/tmp/m2c-test-"));
}, 30000);
afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
describe("built stacks", () => {
  it("reports roles, topics, binding and capability names without their values", () => {
    const report = formatValidation(shared);
    expect(report).toContain("Selection store: store-dynamodb");
    expect(report).toContain("Function ingest: ingest");
    expect(report).toContain("Topics ingest: shared -> consumer");
    expect(report).toContain("ERRTRAQ_QUEUE_SHARED_URL");
    expect(report).toContain("queue.produce.shared");
    expect(report).not.toContain("us-east-1");
  });
  it.each([
    ["shared", shared],
    ["per-topic", perTopic],
  ] as const)(
    "constructs only scoped selections and queue mappings for %s",
    async (_name, stack) => {
      for (const id of ["ingest", "consumer"]) {
        const view = deriveDeployment(stack);
        const fn = view.functions.find((item) => item.id === id);
        if (!fn) throw new Error("Missing function");
        const env = Object.fromEntries(
          [...fn.envBindings, ...fn.secretBindings].map((item) => [
            item.binding.name,
            `value-${item.binding.name}`,
          ]),
        );
        const seen: { module: string; context: Record<string, unknown> }[] = [];
        const built = await constructDeployedStack(
          stack,
          id,
          env,
          async (module) => ({
            create(context: Record<string, unknown>) {
              seen.push({ module, context });
              return {};
            },
          }),
        );
        expect(seen.map((item) => item.module).sort()).toEqual(
          deployedPlan(stack, id)
            .selections.map((item) => item.runtimeModule)
            .sort(),
        );
        for (const item of seen) {
          const plan = deployedPlan(stack, id).selections.find(
            (selection) => selection.runtimeModule === item.module,
          );
          expect(Object.keys(item.context.bindings as object).sort()).toEqual(
            plan?.bindings.map((binding) => binding.name).sort(),
          );
          if (plan?.kind === "queue" && id === "consumer")
            expect(item.context.queueConsumers).toEqual(
              view.triggers.flatMap((trigger) =>
                trigger.kind === "queue" && trigger.functionId === id
                  ? [
                      {
                        physical: trigger.physical,
                        topics: trigger.topics,
                        eventSource: env[trigger.eventSourceBinding ?? ""],
                      },
                    ]
                  : [],
              ),
            );
        }
        await built.close();
      }
    },
  );
  it.each([
    ["shared", shared, "aws-dynamodb.ts"],
    ["per-topic", perTopic, "aws-dynamodb-per-topic.ts"],
  ] as const)(
    "builds %s Lambda functions with only required adapters and renders their artifacts",
    async (name, stack, file) => {
      const output = join(temp, `build-${name}`);
      const manifest = await buildStack(
        stack,
        repo,
        output,
        resolve(repo, "stacks", file),
      );
      expect(
        await buildStack(stack, repo, output, resolve(repo, "stacks", file)),
      ).toEqual(manifest);
      expect(Object.keys(manifest.artifacts).sort()).toEqual(
        deriveDeployment(stack)
          .functions.map((fn) => fn.id)
          .sort(),
      );
      for (const fn of deriveDeployment(stack).functions) {
        const directory = join(output, fn.id);
        const meta = JSON.parse(
          await readFile(join(directory, "meta.json"), "utf8"),
        ) as { inputs: Record<string, unknown> };
        const inputs = Object.keys(meta.inputs).join("\n");
        for (const localAdapter of [
          "store-sql",
          "queue-memory",
          "blob-fs",
          "kv-memory",
        ])
          expect(inputs).not.toContain(`packages/adapters/${localAdapter}/`);
        const selected = new Set(
          deployedPlan(stack, fn.id).selections.map((item) =>
            item.runtimeModule.split("/").at(-1),
          ),
        );
        for (const adapter of [
          "store-dynamodb",
          "queue-sqs",
          "blob-s3",
          "kv-dynamodb",
        ])
          if (!selected.has(adapter))
            expect(inputs).not.toContain(`packages/adapters/${adapter}/`);
        const entry = await import(
          pathToFileURL(join(directory, "index.mjs")).href
        );
        expect(typeof entry.handler).toBe("function");
        const zip = unzipSync(await readFile(join(directory, "bundle.zip")));
        expect(Object.keys(zip)).toEqual(["index.mjs"]);
        expect(
          JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
        ).toEqual(manifest.artifacts[fn.id]);
      }
      const target = join(temp, `terraform-${name}`);
      await generateInfra(stack, repo, target, output, false);
      const main = JSON.parse(
        await readFile(join(target, "main.tf.json"), "utf8"),
      );
      for (const fn of deriveDeployment(stack).functions) {
        const artifact = manifest.artifacts[fn.id];
        expect(artifact).toBeDefined();
        expect(
          resolve(target, main.module.platform.functions[fn.id].artifact),
        ).toBe(resolve(repo, artifact?.path ?? ""));
      }
      await writeFile(join(target, "backend.tf.json"), "{}");
      const markerPath = join(target, ".errtraq-generated.json");
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      marker.files.push("backend.tf.json");
      await writeFile(markerPath, JSON.stringify(marker));
      await generateInfra(stack, repo, target, output, false);
      expect(await readdir(target)).not.toContain("backend.tf.json");
    },
    30000,
  );
  it("builds a standalone Node bundle without AWS adapters", async () => {
    const output = join(temp, "local");
    await buildStack(local, repo, output, resolve(repo, "stacks/local.ts"));
    const meta = JSON.parse(
      await readFile(join(output, "shared/meta.json"), "utf8"),
    ) as { inputs: Record<string, unknown> };
    const inputs = Object.keys(meta.inputs).join("\n");
    for (const name of ["store-sql", "queue-memory", "blob-fs", "kv-memory"])
      expect(inputs).toContain(`packages/adapters/${name}/`);
    for (const name of [
      "store-dynamodb",
      "queue-sqs",
      "blob-s3",
      "kv-dynamodb",
    ])
      expect(inputs).not.toContain(`packages/adapters/${name}/`);
  }, 30000);
  it("rejects unowned and outside output directories and missing artifacts", async () => {
    const directory = join(temp, "unowned");
    await import("node:fs/promises").then((fs) => fs.mkdir(directory));
    await writeFile(join(directory, "user.txt"), "keep");
    await expect(
      generateInfra(shared, repo, directory, join(temp, "build-shared"), false),
    ).rejects.toThrow("no generator marker");
    await expect(
      generateInfra(
        shared,
        repo,
        resolve(repo, "..", "outside"),
        join(temp, "build-shared"),
        false,
      ),
    ).rejects.toThrow("inside the repository");
    await expect(
      generateInfra(
        shared,
        repo,
        join(temp, "missing"),
        join(temp, "no-build"),
        false,
      ),
    ).rejects.toThrow("Build manifest not found");
    expect(
      await generateInfra(
        shared,
        repo,
        join(temp, "placeholders"),
        join(temp, "no-build"),
        true,
      ),
    ).toContain("artifact paths are placeholders");
    const spaced = join(temp, "path with spaces");
    expect(
      await generateInfra(
        shared,
        repo,
        spaced,
        join(temp, "build-shared"),
        false,
      ),
    ).toContain(`cd '${spaced}' && terraform init`);
    const linked = join(temp, "linked");
    await import("node:fs/promises").then((fs) => fs.mkdir(linked));
    await symlink(
      join(directory, "user.txt"),
      join(linked, ".errtraq-generated.json"),
    );
    await expect(
      generateInfra(shared, repo, linked, join(temp, "build-shared"), false),
    ).rejects.toThrow("symbolic link");
    await expect(
      buildStack(
        shared,
        repo,
        directory,
        resolve(repo, "stacks/aws-dynamodb.ts"),
      ),
    ).rejects.toThrow("no build manifest");
    expect(
      await generateInfra(
        local,
        repo,
        join(temp, "no-terraform"),
        join(temp, "no-build"),
        false,
      ),
    ).toContain("no Terraform");
    const manifest = JSON.parse(
      await readFile(join(temp, "build-shared/manifest.json"), "utf8"),
    );
    const artifact = resolve(repo, manifest.artifacts.ingest.path);
    await writeFile(artifact, "tampered");
    await expect(
      generateInfra(
        shared,
        repo,
        join(temp, "bad-hash"),
        join(temp, "build-shared"),
        false,
      ),
    ).rejects.toThrow("hash mismatch");
  });
});
