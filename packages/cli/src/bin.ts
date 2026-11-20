#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { physicalFunctions, resolveStack, selections } from "@errtraq/core";
import { constructStack } from "./construction.js";
import { devToken } from "./token.js";

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
  const [command, ...initial] = args;
  const rotate = command === "token" && initial[0] === "rotate";
  const rest = rotate ? initial.slice(1) : initial;
  const at = rest.indexOf("--stack");
  if (
    (!["dev", "validate"].includes(command ?? "") && !rotate) ||
    at < 0 ||
    !rest[at + 1] ||
    rest.length !== 2
  )
    throw new Error(
      "Usage: errtraq <dev|validate|token rotate> --stack <file>",
    );
  const file = resolve(rest[at + 1]);
  const imported: unknown = await import(pathToFileURL(file).href);
  if (!imported || typeof imported !== "object" || !("default" in imported))
    throw new Error("Stack must export a default configuration");
  const stack = resolveStack(imported.default);
  if (command === "validate") {
    console.log(`Valid stack: ${stack.name}`);
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
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
