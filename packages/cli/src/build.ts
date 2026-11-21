import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type BuildArtifact,
  containsLocalPath,
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
  dockerfile?: "Dockerfile";
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
    if (!entries.includes("manifest.json"))
      throw new Error(
        `Build output is not empty and has no build manifest: ${entries.join(", ")}`,
      );
    if ((await lstat(join(output, "manifest.json"))).isSymbolicLink())
      throw new Error("Invalid build manifest: manifest.json");
    const previous = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    ) as BuildManifest;
    if (
      previous.stack !== stack.name ||
      previous.platform !== stack.platform.manifest.id
    )
      throw new Error("Build output belongs to another stack: manifest.json");
    const previousFunctions = new Set([
      ...Object.keys(previous.artifacts ?? {}),
      ...(previous.platform === "standalone" ? ["shared"] : []),
    ]);
    if (
      entries.includes("Dockerfile") &&
      (stack.platform.manifest.id !== "standalone" ||
        previous.dockerfile !== "Dockerfile" ||
        (await lstat(join(output, "Dockerfile"))).isSymbolicLink())
    )
      throw new Error("Invalid generated Dockerfile");
    const unexpected = entries.filter(
      (entry) =>
        entry !== "manifest.json" &&
        entry !== "Dockerfile" &&
        !previousFunctions.has(entry),
    );
    if (unexpected.length)
      throw new Error(
        `Build output contains files not owned by the build: ${unexpected.join(", ")}`,
      );
    for (const entry of entries.filter(
      (name) => name !== "manifest.json" && name !== "Dockerfile",
    )) {
      const path = join(output, entry);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Invalid build output directory: ${entry}`);
      for (const file of await readdir(path)) {
        if (
          !["index.mjs", "meta.json", "bundle.zip", "manifest.json"].includes(
            file,
          ) ||
          (await lstat(join(path, file))).isSymbolicLink()
        )
          throw new Error(
            `Build output contains files not owned by the build: ${entry}/${file}`,
          );
      }
    }
    const current = new Set(view.functions.map((fn) => fn.id));
    for (const entry of entries)
      if (previousFunctions.has(entry) && !current.has(entry))
        await rm(join(output, entry), { recursive: true });
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
      entry = `${imports}\nimport { constructDeployedPlan, createCronHandler, env, variable } from "@errtraq/core";\nimport { createHandler, retryableInitialization } from "@errtraq/platform-aws-lambda/handler";\nconst plan=${sourceValue(plan)}; const modules={${modules}}; const kinds=${JSON.stringify(kinds)}; const logger={debug:(m,f)=>console.debug(m,f??{}),info:(m,f)=>console.info(m,f??{}),warn:(m,f)=>console.warn(m,f??{}),error:(m,f)=>console.error(m,f??{})};\nconst getHandler=retryableInitialization(async()=>{ const built=await constructDeployedPlan(plan,process.env, async (name)=>{ if(!Object.hasOwn(modules,name)) throw new Error("Unknown module "+name); return modules[name]; }, logger); try { const adapters=Object.fromEntries(Object.entries(kinds).map(([kind,path])=>[kind,built.instances.get(path)])); const cronHandler=createCronHandler({warn:(message,fields)=>console.warn(message,fields??{}),error:(message,fields)=>console.error(message,fields??{})}); return createHandler({roles:${JSON.stringify(fn.roles)},http:${JSON.stringify(fn.http)},adapters,cronHandler,logger}); } catch(error) { try { await built.close(); } catch(cleanup) { throw new AggregateError([error,cleanup],"Handler creation and cleanup failed"); } throw error; } });\nexport async function handler(event){return (await getHandler())(event);}\n`;
    } else if (stack.platform.manifest.id === "standalone") {
      const localImport = (path: string) => {
        const location = relative(repo, path).split(sep).join("/");
        return location.startsWith("./") || location.startsWith("../")
          ? location
          : `./${location}`;
      };
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
      entry = `${imports}\nimport stack from ${JSON.stringify(localImport(stackFile))};\nimport {constructStack} from "./packages/cli/src/construction.ts";\nimport {devToken} from "./packages/cli/src/token.ts";\nimport {dsnOrigin} from "./packages/cli/src/address.ts";\nconst modules={${modules}};\nconst built=await constructStack(stack,${JSON.stringify(fn.roles)},process.env,async(name)=>{if(!Object.hasOwn(modules,name)) throw new Error("Unknown module "+name); return modules[name];});\nconst project=await built.platform.prepare(false,devToken); const server=await built.platform.start();\nconst destination=dsnOrigin(server.host,server.port,server.publicUrl); if(destination.fallback) console.log("Note: DSN uses localhost; use your public host for remote clients."); const dsn=new URL(destination.origin); dsn.username=project.publicKey; dsn.pathname="/"+project.projectId; console.log("DSN: "+dsn.toString()); console.log("API token: "+project.token); console.log("Listening: http://"+server.host+":"+server.port);\nlet stopping=false;
for(const signal of ["SIGTERM","SIGINT"]) process.on(signal,()=>{if(stopping){if(process.pid===1) process.exit(signal==="SIGTERM"?143:130); process.removeAllListeners(signal); process.kill(process.pid,signal); return;} stopping=true; void server.close().then(()=>built.close()).catch((error)=>{console.error(error);process.exitCode=1;});});`;
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
    const meta = result.metafile;
    const inputPaths = Object.entries(meta.inputs).flatMap(([path, input]) => [
      path,
      ...input.imports.flatMap((item) => [item.path, item.original ?? ""]),
    ]);
    if (
      inputPaths.some((path) => isAbsolute(path)) ||
      [repo, homedir()].some((path) => containsLocalPath(file.text, path))
    )
      throw new Error("Build output contains an absolute repository path");
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
  if (stack.platform.manifest.id === "standalone") {
    const id = view.functions[0]?.id;
    if (!id || view.functions.length !== 1)
      throw new Error("Standalone requires one function");
    const dockerfile = `FROM node:22.23-bookworm-slim\nWORKDIR /app\nRUN mkdir -p /data && chown node:node /data\nCOPY --chown=node:node ${id}/index.mjs /app/index.mjs\n# Explicitly opt in to listening on the container network.\nENV ERRTRAQ_HOST=0.0.0.0 ERRTRAQ_DATA_DIR=/data\nUSER node\nVOLUME ["/data"]\nEXPOSE 8787\nHEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.ERRTRAQ_PORT||'8787')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"\nENTRYPOINT ["node", "/app/index.mjs"]\n`;
    await writeFile(join(output, "Dockerfile"), dockerfile);
    manifest.dockerfile = "Dockerfile";
  }
  await writeFile(
    join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
