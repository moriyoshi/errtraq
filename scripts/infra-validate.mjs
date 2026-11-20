import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

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
};
function run(args, cwd) {
  const result = spawnSync("terraform", args, {
    cwd,
    env: { ...env, TF_DATA_DIR: resolve(cwd, ".terraform") },
    encoding: "utf8",
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
  if (/Warning:[\s\S]*?deprecated/i.test(output)) {
    process.stdout.write(output);
    throw new Error(`terraform ${args[0]} emitted a deprecation warning`);
  }
}
try {
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
      for (const version of ["6.30.0", "6.73.0"]) {
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
        if (!source.includes('version = ">= 6.30.0, < 7.0"'))
          throw new Error(`Unexpected provider constraint in ${name}`);
        writeFileSync(
          versions,
          source.replace(
            'version = ">= 6.30.0, < 7.0"',
            `version = "= ${version}"`,
          ),
        );
        console.log(`\nValidating ${name} with AWS provider ${version}`);
        run(["init", "-backend=false", "-input=false", "-no-color"], target);
        run(["validate", "-no-color"], target);
        run(["test", "-no-color"], target);
      }
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
