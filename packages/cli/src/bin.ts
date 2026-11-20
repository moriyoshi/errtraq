#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ActiveStore,
  type AdapterSelection,
  type BlobStore,
  bootstrapProject,
  type KV,
  type Queue,
  resolveStack,
  WebCryptoIdGen,
} from "@errtraq/core";
import { devToken } from "./token.js";

async function load(selection: AdapterSelection): Promise<unknown> {
  const module: unknown = await import(selection.runtimeModule);
  if (
    !module ||
    typeof module !== "object" ||
    !("create" in module) ||
    typeof module.create !== "function"
  )
    throw new Error(`Invalid adapter: ${selection.manifest.id}`);
  return module.create(selection.config, selection.existing ?? {});
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
  const storeConfig = stack.store.config as { path?: unknown };
  if (typeof storeConfig.path === "string" && storeConfig.path !== ":memory:")
    await mkdir(dirname(storeConfig.path), { recursive: true });
  const store = (await load(stack.store)) as ActiveStore & {
    close?: () => Promise<void>;
  };
  try {
    await store.migrate();
    const queue = (await load(stack.queue)) as Queue;
    const blobs = (await load(stack.blob)) as BlobStore;
    const kv = (await load(stack.kv)) as KV;
    const ids = new WebCryptoIdGen();
    const project = await bootstrapProject({
      store,
      kv,
      ids,
      orgSlug: "default",
      projectSlug: "default",
    });
    if (typeof storeConfig.path !== "string" || storeConfig.path === ":memory:")
      throw new Error("Local token storage requires a file-backed store");
    const token = await devToken(
      store,
      ids,
      project.org.id,
      dirname(storeConfig.path),
      rotate,
    );
    if (rotate) {
      console.log(`API token: ${token}`);
      return;
    }
    const platformModule: unknown = await import(stack.platform.runtimeModule);
    if (
      !platformModule ||
      typeof platformModule !== "object" ||
      !("create" in platformModule) ||
      typeof platformModule.create !== "function"
    )
      throw new Error("Invalid platform adapter");
    const platform = platformModule.create(stack.platform.config, {
      store,
      queue,
      blobs,
      kv,
    }) as {
      start: () => Promise<{
        host: string;
        port: number;
        close: () => Promise<void>;
      }>;
    };
    const server = await platform.start();
    const urlHost = server.host.includes(":")
      ? `[${server.host}]`
      : server.host;
    console.log(
      `DSN: http://${project.key.publicKey}@${urlHost}:${server.port}/${project.project.id}`,
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
  } finally {
    await store.close?.();
  }
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
