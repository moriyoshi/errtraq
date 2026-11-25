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
  snapshotPaths,
} from "./infra-shapes.mjs";

const root = resolve("infra/modules");
const fixtureRoot = resolve("infra/fixtures");
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
  // A -json run embeds provider schemas whose descriptions say "deprecated"; only diagnostics count there.
  const checked = args.includes("-json")
    ? output
        .split("\n")
        .flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event.type === "diagnostic" &&
              event.diagnostic?.severity === "warning"
              ? [
                  `Warning: ${event.diagnostic.summary} ${event.diagnostic.detail ?? ""}`,
                ]
              : [];
          } catch {
            return [];
          }
        })
        .join("\n")
    : output;
  if (
    /Warning:[\s\S]*?deprecated/i.test(checked) ||
    /"summary"\s*:\s*"[^"]*deprecated/i.test(checked)
  ) {
    process.stdout.write(checked);
    throw new Error(`terraform ${args[0]} emitted a deprecation warning`);
  }
  return output;
}
// Each provider family pins two versions for validation: the floor and a recent release. A module may
// raise its own floor (lambda-app needs a provider whose runtime enum includes nodejs26.x).
const families = {
  aws: {
    label: "AWS",
    constraint: /version = ">= (\d+\.\d+\.\d+), < 7\.0"/,
    versions: ["6.32.1", "6.73.0"],
    defaultFloor: "6.32.1",
  },
  google: {
    label: "Google",
    constraint: /version = ">= (\d+\.\d+\.\d+), < 9\.0"/,
    versions: ["8.0.0", "8.12.0"],
    defaultFloor: "8.0.0",
  },
};
const observed = { aws: {}, google: {} };
const platform = `${process.platform === "win32" ? "windows" : process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
function cachedProvider(source, version) {
  const directory = resolve(
    cache,
    "registry.terraform.io",
    "hashicorp",
    source,
    version,
    platform,
  );
  return (
    existsSync(directory) &&
    readdirSync(directory).some((name) =>
      name.startsWith(`terraform-provider-${source}_v${version}`),
    )
  );
}
try {
  const build = spawnSync("pnpm", ["build"], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("Workspace build failed");
  const { fixtures, prepareRoot } = await import("./infra-roots.mjs");
  console.log("Checking Terraform module formatting");
  run(["fmt", "-check", "-recursive", root], process.cwd());
  run(["fmt", "-check", "-recursive", fixtureRoot], process.cwd());
  for (const provider of readdirSync(root, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  )) {
    const family = families[provider.name];
    if (!family) throw new Error(`No provider family for ${provider.name}`);
    const providerRoot = resolve(root, provider.name);
    for (const component of readdirSync(providerRoot, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory())) {
      const name = `${provider.name}/${component.name}`;
      const floor =
        readFileSync(
          resolve(providerRoot, component.name, "versions.tf"),
          "utf8",
        ).match(family.constraint)?.[1] ?? family.defaultFloor;
      const atLeastFloor = (version) => {
        const a = version.split(".").map(Number);
        const b = floor.split(".").map(Number);
        for (let i = 0; i < 3; i += 1)
          if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
        return true;
      };
      for (const version of family.versions.filter(atLeastFloor)) {
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
        const constraint = source.match(family.constraint)?.[0];
        if (!constraint)
          throw new Error(`Unexpected provider constraint in ${name}`);
        writeFileSync(
          versions,
          source.replace(constraint, `version = "= ${version}"`),
        );
        console.log(
          `\nValidating ${name} with ${family.label} provider ${version}`,
        );
        const cached = cachedProvider(provider.name, version);
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
          const seen = observed[provider.name];
          if (
            seen[component.name] &&
            JSON.stringify(seen[component.name]) !== JSON.stringify(current)
          )
            throw new Error(
              `Provider versions disagree on ${component.name} output shape`,
            );
          seen[component.name] = current;
        } else checkShape(component.name, current, provider.name);
        console.log(`  shape: matched`);
      }
    }
  }
  // Test-only fixtures (not product modules): validate and mock-test only.
  for (const version of ["6.32.1", "6.73.0"]) {
    for (const fixture of ["aws/rds-postgres"]) {
      const target = resolve(temporary, `fixtures-${version}`, fixture);
      mkdirSync(target, { recursive: true });
      cpSync(resolve(fixtureRoot, fixture), target, { recursive: true });
      const versions = resolve(target, "versions.tf");
      const source = readFileSync(versions, "utf8");
      if (!source.includes('version = ">= 6.32.1, < 7.0"'))
        throw new Error(`Unexpected provider constraint in fixture ${fixture}`);
      writeFileSync(
        versions,
        source.replace(
          'version = ">= 6.32.1, < 7.0"',
          `version = "= ${version}"`,
        ),
      );
      console.log(
        `\nValidating fixture ${fixture} with AWS provider ${version}`,
      );
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
      const initArgs = ["init", "-backend=false", "-input=false", "-no-color"];
      if (cached) initArgs.push(`-plugin-dir=${cache}`);
      run(initArgs, target, cached);
      run(["validate", "-no-color"], target);
      run(["test", "-no-color"], target);
    }
  }
  if (process.env.UPDATE_INFRA_SHAPES === "1")
    for (const [provider, shapes] of Object.entries(observed))
      writeFileSync(
        snapshotPaths[provider],
        `${JSON.stringify(shapes, null, 2)}\n`,
      );
  // Every generated root contains the lambda-app module, so the minimum provider version tested
  // here is the lambda-app floor.
  const lambdaFloor = readFileSync(
    resolve(root, "aws/lambda-app/versions.tf"),
    "utf8",
  ).match(/version = ">= (\d+\.\d+\.\d+), < 7\.0"/)?.[1];
  for (const version of ["6.32.1", "6.73.0"].filter(
    (candidate) => lambdaFloor !== undefined && candidate >= lambdaFloor,
  )) {
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
  const { gcpFixtures, prepareGcpRoot } = await import("./infra-gcp-roots.mjs");
  for (const version of families.google.versions) {
    for (const name of Object.keys(gcpFixtures)) {
      const target = prepareGcpRoot(
        resolve(temporary, `gcp-roots-${version}`),
        name,
        version,
      );
      console.log(
        `\nValidating generated ${name} with Google provider ${version}`,
      );
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
      run(["test", "-no-color"], target);
    }
  }
  console.log(
    `Generated Google roots: ${Object.keys(gcpFixtures).length} variants passed at both pinned provider versions.`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
