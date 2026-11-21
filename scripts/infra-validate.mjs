import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  capturedShape,
  checkShape,
  shapeFixture,
  snapshotPath,
} from "./infra-shapes.mjs";

const root = resolve("infra/modules");
const scratch = resolve(".agents-workspace/tmp");
const cache = resolve(scratch, "terraform-plugin-cache");
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(resolve(scratch, "terraform-modules-"));
const env = {
  ...process.env,
  TF_PLUGIN_CACHE_DIR: cache,
  TF_IN_AUTOMATION: "1",
  CHECKPOINT_DISABLE: "1",
  TF_VAR_SECRET: "errtraq-sensitive-canary",
};
function run(args, cwd, offline = false) {
  const commandEnv = { ...env, TF_DATA_DIR: resolve(cwd, ".terraform") };
  if (offline) delete commandEnv.TF_PLUGIN_CACHE_DIR;
  const result = spawnSync("terraform", args, {
    cwd,
    env: commandEnv,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`terraform ${args[0]} exited ${result.status}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const summary = output.match(/Success! \d+ passed, \d+ failed\./)?.[0];
  console.log(`  ${args[0]}: ${summary ?? "passed"}`);
  if (
    /Warning:[\s\S]*?deprecated/i.test(output) ||
    /"summary"\s*:\s*"[^"]*deprecated/i.test(output)
  ) {
    process.stdout.write(output);
    throw new Error(`terraform ${args[0]} emitted a deprecation warning`);
  }
  return output;
}
const observed = {};
try {
  const build = spawnSync("pnpm", ["build"], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("Workspace build failed");
  const { fixtures, prepareRoot } = await import("./infra-roots.mjs");
  console.log("Checking Terraform module formatting");
  run(["fmt", "-check", "-recursive", root], process.cwd());
  for (const provider of readdirSync(root, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  )) {
    const providerRoot = resolve(root, provider.name);
    for (const component of readdirSync(providerRoot, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory())) {
      const name = `${provider.name}/${component.name}`;
      for (const version of ["6.32.1", "6.73.0"]) {
        const target = resolve(
          temporary,
          version,
          provider.name,
          component.name,
        );
        mkdirSync(target, { recursive: true });
        cpSync(resolve(providerRoot, component.name), target, {
          recursive: true,
        });
        const versions = resolve(target, "versions.tf");
        const source = readFileSync(versions, "utf8");
        if (!source.includes('version = ">= 6.32.1, < 7.0"'))
          throw new Error(`Unexpected provider constraint in ${name}`);
        writeFileSync(
          versions,
          source.replace(
            'version = ">= 6.32.1, < 7.0"',
            `version = "= ${version}"`,
          ),
        );
        console.log(`\nValidating ${name} with AWS provider ${version}`);
        const platform = `${process.platform === "win32" ? "windows" : process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
        const cachedDirectory = resolve(
          cache,
          "registry.terraform.io",
          "hashicorp",
          "aws",
          version,
          platform,
        );
        const cached =
          existsSync(cachedDirectory) &&
          readdirSync(cachedDirectory).some((name) =>
            name.startsWith(`terraform-provider-aws_v${version}`),
          );
        const initArgs = [
          "init",
          "-backend=false",
          "-input=false",
          "-no-color",
        ];
        if (cached) initArgs.push(`-plugin-dir=${cache}`);
        run(initArgs, target, cached);
        run(["validate", "-no-color"], target);
        run(["test", "-no-color"], target);
        const fixturePath = resolve(target, "tests", "shapes.tftest.hcl");
        writeFileSync(
          fixturePath,
          shapeFixture(
            readFileSync(
              resolve(target, "tests", "contract.tftest.hcl"),
              "utf8",
            ),
          ),
        );
        const output = run(
          [
            "test",
            "-json",
            "-verbose",
            "-no-color",
            "-filter=tests/shapes.tftest.hcl",
          ],
          target,
        );
        const current = capturedShape(output, component.name);
        if (process.env.UPDATE_INFRA_SHAPES === "1") {
          if (
            observed[component.name] &&
            JSON.stringify(observed[component.name]) !== JSON.stringify(current)
          )
            throw new Error(
              `Provider versions disagree on ${component.name} output shape`,
            );
          observed[component.name] = current;
        } else checkShape(component.name, current);
        console.log(`  shape: matched`);
      }
    }
  }
  if (process.env.UPDATE_INFRA_SHAPES === "1")
    writeFileSync(snapshotPath, `${JSON.stringify(observed, null, 2)}\n`);
  for (const version of ["6.32.1", "6.73.0"]) {
    for (const name of Object.keys(fixtures)) {
      const target = prepareRoot(
        resolve(temporary, `roots-${version}`),
        name,
        version,
      );
      console.log(
        `\nValidating generated ${name} with AWS provider ${version}`,
      );
      for (const file of readdirSync(target).filter((f) => f.endsWith(".json")))
        if (
          readFileSync(resolve(target, file), "utf8").includes(
            env.TF_VAR_SECRET,
          )
        )
          throw new Error(`Sensitive value leaked into ${name}/${file}`);
      run(["fmt", "-check"], target);
      run(
        [
          "init",
          "-backend=false",
          "-input=false",
          "-no-color",
          `-plugin-dir=${cache}`,
        ],
        target,
        true,
      );
      run(["validate", "-no-color"], target);
      const result = run(["test", "-json", "-verbose", "-no-color"], target);
      const state = result
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((item) => item.type === "test_state")?.test_state;
      if (!state) throw new Error(`Missing mock state for ${name}`);
      for (const [key, value] of Object.entries(state.outputs ?? {}))
        if (
          !value.sensitive &&
          JSON.stringify(value.value).includes(env.TF_VAR_SECRET)
        )
          throw new Error(`Sensitive value leaked into output ${key}`);
      if (
        name === "existing" &&
        state.root_module.child_modules.some((module) =>
          ["module.store", "module.queue"].includes(module.address),
        )
      )
        throw new Error("Existing selections unexpectedly created resources");
      console.log("  derived deployment and sensitive outputs: matched");
    }
  }
  console.log(
    `Generated roots: ${Object.keys(fixtures).length} variants passed at both pinned provider versions.`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
