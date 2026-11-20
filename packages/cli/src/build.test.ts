import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  constructDeployedStack,
  containsLocalPath,
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
import { resolveRuntimeValue } from "./runtime.js";
import { formatValidation } from "./validation.js";

const repo = process.cwd();
let temp: string;
async function assertNoLocalPaths(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoLocalPaths(path);
    else {
      const bytes = await readFile(path);
      for (const localPath of [repo, homedir()])
        expect(containsLocalPath(bytes.toString("utf8"), localPath)).toBe(
          false,
        );
      if (entry.name.endsWith(".zip"))
        for (const contents of Object.values(unzipSync(bytes)))
          for (const localPath of [repo, homedir()])
            expect(
              containsLocalPath(
                Buffer.from(contents).toString("utf8"),
                localPath,
              ),
            ).toBe(false);
    }
  }
}
beforeAll(async () => {
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(resolve(repo, ".agents-workspace/tmp"), { recursive: true }),
  );
  temp = await mkdtemp(resolve(repo, ".agents-workspace/tmp/m2c-test-"));
}, 30000);
afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
describe("built stacks", () => {
  it("builds and checks Sentry fixtures from a copied src/app checkout", async () => {
    const scratch = await mkdtemp(join(await realpath("/tmp"), "errtraq-m2d-"));
    const copy = join(scratch, "src", "app");
    try {
      await mkdir(copy, { recursive: true });
      for (const name of [
        "packages",
        "stacks",
        "scripts",
        "infra",
        "package.json",
        "pnpm-workspace.yaml",
        "tsconfig.base.json",
        "tsconfig.tests.json",
        "tsconfig.node-tests.json",
        "vitest.config.ts",
        "README.md",
      ])
        await cp(join(repo, name), join(copy, name), {
          recursive: true,
          filter: (path) =>
            !path
              .split(/[\\/]/)
              .some((part) =>
                ["node_modules", "dist", "generated"].includes(part),
              ),
        });
      await symlink(
        join(repo, "node_modules"),
        join(copy, "node_modules"),
        "dir",
      );
      const output = join(copy, ".agents-workspace/tmp/build");
      await buildStack(local, copy, output, join(copy, "stacks/local.ts"));
      const fixture = spawnSync(
        process.execPath,
        [
          join(repo, "node_modules/vitest/vitest.mjs"),
          "run",
          "packages/testing/src/sentry-fixtures.test.ts",
          "--reporter=dot",
        ],
        {
          cwd: copy,
          encoding: "utf8",
          env: { ...process.env, FORCE_COLOR: "0" },
          timeout: 30000,
        },
      );
      expect(fixture.status, `${fixture.stdout}\n${fixture.stderr}`).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60000);
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
      await assertNoLocalPaths(output);
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
      const report = await generateInfra(stack, repo, target, output, false);
      expect(report).toContain(relative(repo, target));
      expect(report).not.toContain(repo);
      await assertNoLocalPaths(target);
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
      await mkdir(join(target, ".terraform"));
      for (const file of [
        ".terraform.lock.hcl",
        "terraform.tfstate",
        "terraform.tfstate.backup",
        "pending.tfplan",
        "crash.log",
        "crash.123.log",
        ".terraform/sentinel",
      ])
        await writeFile(join(target, file), `preserve:${file}`);
      await generateInfra(stack, repo, target, output, false);
      for (const file of [
        ".terraform.lock.hcl",
        "terraform.tfstate",
        "terraform.tfstate.backup",
        "pending.tfplan",
        "crash.log",
        "crash.123.log",
        ".terraform/sentinel",
      ])
        expect(await readFile(join(target, file), "utf8")).toBe(
          `preserve:${file}`,
        );
      const other = name === "shared" ? perTopic : shared;
      await expect(
        generateInfra(
          other,
          repo,
          target,
          join(temp, `build-${name === "shared" ? "per-topic" : "shared"}`),
          true,
        ),
      ).rejects.toThrow(`belongs to stack ${stack.name}`);
    },
    30000,
  );
  it("builds a standalone Node bundle without AWS adapters", async () => {
    const output = join(temp, "local");
    await buildStack(local, repo, output, resolve(repo, "stacks/local.ts"));
    await assertNoLocalPaths(output);
    const dockerfile = await readFile(join(output, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM node:22-bookworm-slim");
    expect(dockerfile).toContain(
      "ENV ERRTRAQ_HOST=0.0.0.0 ERRTRAQ_DATA_DIR=/data",
    );
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/index.mjs"]');
    expect(
      resolveRuntimeValue(local.platform.config, "platform", local, {}),
    ).toMatchObject({ host: "127.0.0.1" });
    expect(
      resolveRuntimeValue(local.platform.config, "platform", local, {
        ERRTRAQ_HOST: "0.0.0.0",
      }),
    ).toMatchObject({ host: "0.0.0.0" });
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
    await buildStack(local, repo, output, resolve(repo, "stacks/local.ts"));
    const manifestPath = join(output, "manifest.json");
    const oldManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete oldManifest.dockerfile;
    await writeFile(manifestPath, JSON.stringify(oldManifest));
    await expect(
      buildStack(local, repo, output, resolve(repo, "stacks/local.ts")),
    ).rejects.toThrow("Invalid generated Dockerfile");
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
    try {
      await generateInfra(
        shared,
        repo,
        join(temp, "missing"),
        join(temp, "no-build"),
        false,
      );
      throw new Error("Expected a missing build error");
    } catch (error) {
      expect(String(error)).not.toContain(repo);
      expect(String(error)).not.toContain("ENOENT");
    }
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
    ).toContain(`cd '${relative(repo, spaced)}' && terraform init`);
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
    await rm(artifact);
    await expect(
      generateInfra(
        shared,
        repo,
        join(temp, "missing-artifact"),
        join(temp, "build-shared"),
        false,
      ),
    ).rejects.toThrow("Build artifact missing for ingest");
    expect(
      await generateInfra(
        shared,
        repo,
        join(temp, "some-placeholders"),
        join(temp, "build-shared"),
        true,
      ),
    ).toContain("artifact paths are placeholders");
  });
});
