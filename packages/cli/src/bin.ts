#!/usr/bin/env node
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { physicalFunctions, resolveStack, selections } from "@errtraq/core";
import { buildStack } from "./build.js";
import { constructStack } from "./construction.js";
import { generateInfra, repositoryRoot, safeDirectory } from "./infra.js";
import { assertNodeVersion } from "./node-version.js";
import { devToken } from "./token.js";
import { formatValidation } from "./validation.js";

interface DevPlatform {
  prepare(
    rotate: boolean,
    tokenManager: typeof devToken,
  ): Promise<{ token: string; publicKey: string; projectId: string }>;
  start(): Promise<{ host: string; port: number; close(): Promise<void> }>;
}
function isDevPlatform(value: unknown): value is DevPlatform {
  return (
    !!value &&
    typeof value === "object" &&
    "prepare" in value &&
    typeof value.prepare === "function" &&
    "start" in value &&
    typeof value.start === "function"
  );
}
export async function main(args: string[]): Promise<void> {
  assertNodeVersion(process.versions.node);
  const [command, ...initial] = args;
  const rotate = command === "token" && initial[0] === "rotate";
  const infra = command === "infra" && initial[0] === "generate";
  const rest = rotate || infra ? initial.slice(1) : initial;
  if (
    !rotate &&
    !infra &&
    !["dev", "validate", "build"].includes(command ?? "")
  )
    throw new Error(
      "Usage: errtraq <dev|validate|build|infra generate|token rotate> --stack <file> [--out dir]",
    );
  const options: Record<string, string> = {};
  let allowMissing = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--allow-missing-artifacts" && infra) {
      allowMissing = true;
      continue;
    }
    if (
      !flag ||
      !["--stack", "--out", "--build-dir"].includes(flag) ||
      !rest[i + 1] ||
      options[flag]
    )
      throw new Error("Invalid command arguments");
    options[flag] = rest[++i] ?? "";
  }
  if (
    !options["--stack"] ||
    (options["--out"] && !(infra || command === "build")) ||
    (options["--build-dir"] && !infra)
  )
    throw new Error("Invalid command arguments: --stack is required");
  const file = resolve(options["--stack"]);
  const imported: unknown = await import(pathToFileURL(file).href);
  if (!imported || typeof imported !== "object" || !("default" in imported))
    throw new Error("Stack must export a default configuration");
  const stack = resolveStack(imported.default);
  if (command === "validate") {
    console.log(formatValidation(stack));
    return;
  }
  if (command === "build" || infra) {
    const repo = await repositoryRoot(process.cwd());
    const defaultBuild = resolve(repo, "dist", stack.name);
    if (command === "build") {
      const directory = await safeDirectory(
        repo,
        resolve(options["--out"] ?? defaultBuild),
      );
      const manifest = await buildStack(stack, repo, directory, file);
      console.log(
        `Built ${stack.name} in ${relative(repo, directory)} (${Object.keys(manifest.artifacts).length} deployable artifacts)`,
      );
    } else
      console.log(
        await generateInfra(
          stack,
          repo,
          resolve(
            options["--out"] ?? resolve(repo, "infra/generated", stack.name),
          ),
          resolve(options["--build-dir"] ?? defaultBuild),
          allowMissing,
        ),
      );
    return;
  }
  const platformSelection = [...selections(stack)].find(
    ([path, selection]) =>
      !path.includes(".") && selection.manifest.kind === "platform",
  )?.[1];
  if (!platformSelection) throw new Error("Missing platform adapter");
  const functions = physicalFunctions(platformSelection.config);
  if (functions.length !== 1)
    throw new Error("The dev command requires one physical function");
  const created = await constructStack(
    stack,
    functions[0]?.roles ?? [],
    process.env,
  );
  let failed = false;
  try {
    if (!isDevPlatform(created.platform))
      throw new Error("Platform does not support local development");
    const platform = created.platform;
    const project = await platform.prepare(rotate, devToken);
    const token = project.token;
    if (rotate) {
      console.log(`API token: ${token}`);
      return;
    }
    const server = await platform.start();
    const urlHost = server.host.includes(":")
      ? `[${server.host}]`
      : server.host;
    console.log(
      `DSN: http://${project.publicKey}@${urlHost}:${server.port}/${project.projectId}`,
    );
    console.log(`API token: ${token}`);
    console.log(`Listening: http://${urlHost}:${server.port}`);
    await new Promise<void>((done) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        void server.close().then(done, (error) => {
          console.error(String(error));
          process.exitCode = 1;
          done();
        });
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } catch (error) {
    failed = true;
    try {
      await created.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Operation and cleanup failed",
      );
    }
    throw error;
  } finally {
    if (!failed) await created.close();
  }
}
main(process.argv.slice(2)).catch(async (error) => {
  const repo = await repositoryRoot(process.cwd()).catch(() => undefined);
  let message = error instanceof Error ? error.message : String(error);
  if (repo)
    message = message.replaceAll(`${repo}${sep}`, "").replaceAll(repo, ".");
  const home = homedir();
  if (home.length > 1) message = message.replaceAll(home, "~");
  console.error(message);
  process.exitCode = 1;
});
