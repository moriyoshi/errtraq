import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  type BuildArtifact,
  deployedPlan,
  deriveDeployment,
  isEnvRef,
  isInfraRef,
  isVariableRef,
  type StackConfig,
  selections,
} from "@errtraq/core";
import { build } from "esbuild";
import { strToU8, zipSync } from "fflate";
import { safeDirectory } from "./infra.js";

function sourceValue(value: unknown): string {
  if (isEnvRef(value))
    return `env(${JSON.stringify(value.name)}, ${JSON.stringify({ defaultValue: value.defaultValue, suffix: value.suffix, valueType: value.valueType })})`;
  if (isVariableRef(value)) return `variable(${JSON.stringify(value.name)})`;
  if (isInfraRef(value))
    throw new Error("Unsupported reference in deployed build plan");
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(sourceValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${sourceValue(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export interface BuildManifest {
  stack: string;
  platform: string;
  artifacts: Record<string, BuildArtifact>;
}
export async function buildStack(
  stack: StackConfig,
  repo: string,
  output: string,
  stackFile: string,
): Promise<BuildManifest> {
  const view = deriveDeployment(stack);
  const manifest: BuildManifest = {
    stack: stack.name,
    platform: stack.platform.manifest.id,
    artifacts: {},
  };
  if (stack.platform.manifest.id === "aws-lambda") {
    const config = stack.platform.config as {
      handler?: string;
      runtime?: string;
    };
    if (
      (config.handler ?? "index.handler") !== "index.handler" ||
      (config.runtime ?? "nodejs22.x") !== "nodejs22.x"
    )
      throw new Error(
        "Lambda build requires handler index.handler and runtime nodejs22.x",
      );
  }
  output = await safeDirectory(repo, output);
  const entries = await readdir(output);
  if (entries.length) {
    if (
      !entries.includes("manifest.json") ||
      (await lstat(join(output, "manifest.json"))).isSymbolicLink()
    )
      throw new Error("Build output is not empty and has no build manifest");
    const previous = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    ) as BuildManifest;
    if (
      previous.stack !== stack.name ||
      previous.platform !== stack.platform.manifest.id
    )
      throw new Error("Build output belongs to another stack");
    const allowedFunctions = new Set([
      ...Object.keys(previous.artifacts ?? {}),
      ...view.functions.map((fn) => fn.id),
    ]);
    if (
      entries.some(
        (entry) => entry !== "manifest.json" && !allowedFunctions.has(entry),
      )
    )
      throw new Error("Build output contains files not owned by the build");
    for (const entry of entries.filter((name) => name !== "manifest.json")) {
      const path = join(output, entry);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Invalid build output directory");
      for (const file of await readdir(path)) {
        if (
          !["index.mjs", "meta.json", "bundle.zip", "manifest.json"].includes(
            file,
          ) ||
          (await lstat(join(path, file))).isSymbolicLink()
        )
          throw new Error("Build output contains files not owned by the build");
      }
    }
  }
  for (const fn of view.functions) {
    let entry: string;
    if (stack.platform.manifest.id === "aws-lambda") {
      const plan = deployedPlan(stack, fn.id);
      const specs = [
        ...new Set(plan.selections.map((item) => item.runtimeModule)),
      ];
      const imports = specs
        .map((spec, i) => `import * as m${i} from ${JSON.stringify(spec)};`)
        .join("\n");
      const modules = specs
        .map((spec, i) => `${JSON.stringify(spec)}:m${i}`)
        .join(",");
      const kinds = Object.fromEntries(
        plan.selections
          .filter((item) => !item.path.includes("."))
          .map((item) => [item.kind, item.path]),
      );
      entry = `${imports}\nimport { constructDeployedPlan, env, variable } from "@errtraq/core";\nimport { createHandler } from "@errtraq/platform-aws-lambda/handler";\nconst plan=${sourceValue(plan)}; const modules={${modules}}; const kinds=${JSON.stringify(kinds)};\nlet initialized; async function getHandler(){ return initialized ??= (async()=>{ const built=await constructDeployedPlan(plan,process.env, async (name)=>{ if(!Object.hasOwn(modules,name)) throw new Error("Unknown module "+name); return modules[name]; }); const adapters=Object.fromEntries(Object.entries(kinds).map(([kind,path])=>[kind,built.instances.get(path)])); return createHandler({roles:${JSON.stringify(fn.roles)},http:${JSON.stringify(fn.http)},adapters}); })(); }\nexport async function handler(event){return (await getHandler())(event);}\n`;
    } else if (stack.platform.manifest.id === "standalone") {
      const specs = [
        ...new Set(
          [...selections(stack).values()].map(
            (selection) => selection.runtimeModule,
          ),
        ),
      ];
      const imports = specs
        .map(
          (spec, index) =>
            `import * as m${index} from ${JSON.stringify(spec)};`,
        )
        .join("\n");
      const modules = specs
        .map((spec, index) => `${JSON.stringify(spec)}:m${index}`)
        .join(",");
      entry = `${imports}\nimport stack from ${JSON.stringify(stackFile)};\nimport {constructStack} from ${JSON.stringify(resolve(repo, "packages/cli/src/construction.ts"))};\nimport {devToken} from ${JSON.stringify(resolve(repo, "packages/cli/src/token.ts"))};\nconst modules={${modules}};\nconst built=await constructStack(stack,${JSON.stringify(fn.roles)},process.env,async(name)=>{if(!Object.hasOwn(modules,name)) throw new Error("Unknown module "+name); return modules[name];});\nconst project=await built.platform.prepare(false,devToken); const server=await built.platform.start();\nconsole.log("DSN: http://"+project.publicKey+"@"+server.host+":"+server.port+"/"+project.projectId); console.log("API token: "+project.token); console.log("Listening: http://"+server.host+":"+server.port);\nfor(const signal of ["SIGTERM","SIGINT"]) process.once(signal,()=>{void server.close().then(()=>built.close());});`;
    } else
      throw new Error(
        `Build is not supported for platform ${stack.platform.manifest.id}`,
      );
    const result = await build({
      stdin: {
        contents: entry,
        resolveDir: repo,
        sourcefile: `entry-${fn.id}.ts`,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      conditions: ["development"],
      write: false,
      metafile: true,
      outfile: "index.mjs",
      logLevel: "silent",
    });
    const file = result.outputFiles[0];
    if (!file) throw new Error("esbuild did not produce a bundle");
    const directory = join(output, fn.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.mjs"), file.contents);
    await writeFile(
      join(directory, "meta.json"),
      `${JSON.stringify(result.metafile, null, 2)}\n`,
    );
    if (stack.platform.manifest.id === "aws-lambda") {
      const bytes = zipSync(
        {
          "index.mjs": [
            strToU8(file.text),
            { mtime: new Date(2000, 0, 1, 0, 0, 0) },
          ],
        },
        { level: 6 },
      );
      const artifactPath = join(directory, "bundle.zip");
      await writeFile(artifactPath, bytes);
      const platformConfig = stack.platform.config as {
        handler?: string;
        runtime?: string;
      };
      manifest.artifacts[fn.id] = {
        path: relative(repo, artifactPath).split(sep).join("/"),
        handler: platformConfig.handler ?? "index.handler",
        runtime: platformConfig.runtime ?? "nodejs22.x",
        contentHash: createHash("sha256").update(bytes).digest("base64"),
      };
      await writeFile(
        join(directory, "manifest.json"),
        `${JSON.stringify(manifest.artifacts[fn.id], null, 2)}\n`,
      );
    }
  }
  await writeFile(
    join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
