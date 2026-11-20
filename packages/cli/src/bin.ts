#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ActiveStore,
  type AdapterSelection,
  bootstrapProject,
  type CoreTopic,
  constructionOrder,
  type FunctionRole,
  type KV,
  type PlatformConfig,
  physicalFunctions,
  resolveStack,
  type StackConfig,
  selections,
  type TopicRoute,
  WebCryptoIdGen,
} from "@errtraq/core";
import { resolveRoleBindings, resolveRuntimeValue } from "./runtime.js";
import { devToken } from "./token.js";

async function load(
  path: string,
  selection: AdapterSelection,
  stack: StackConfig,
  created: Map<string, unknown>,
  roles: readonly FunctionRole[],
): Promise<unknown> {
  const module: unknown = await import(selection.runtimeModule);
  if (
    !module ||
    typeof module !== "object" ||
    !("create" in module) ||
    typeof module.create !== "function"
  )
    throw new Error(`Invalid adapter: ${selection.manifest.id}`);
  const dependencies = Object.fromEntries(
    Object.entries(selection.dependsOn ?? {}).map(([alias, target]) => {
      if (!created.has(target))
        throw new Error(`Missing runtime dependency ${target}`);
      return [alias, created.get(target)];
    }),
  );
  const bindings = resolveRoleBindings(stack, roles, path, process.env);
  const topics = Object.fromEntries(
    Object.entries(stack.queue.infra.topics?.routes ?? {}).map(
      ([topic, route]) => [
        topic,
        {
          physical: route.physical,
          ...(route.producerBinding
            ? { producerBinding: route.producerBinding }
            : {}),
        },
      ],
    ),
  ) as Partial<
    Record<CoreTopic, Pick<TopicRoute, "physical" | "producerBinding">>
  >;
  return module.create({
    config: resolveRuntimeValue(selection.config, path, stack, process.env),
    bindings,
    dependencies,
    topics,
  });
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
  const storeConfig = resolveRuntimeValue(
    stack.store.config,
    "store",
    stack,
    process.env,
  ) as { path?: unknown };
  if (typeof storeConfig.path === "string" && storeConfig.path !== ":memory:")
    await mkdir(dirname(storeConfig.path), { recursive: true });
  const selected = selections(stack);
  const functions = physicalFunctions(stack.platform.config as PlatformConfig);
  if (functions.length !== 1)
    throw new Error("The dev command requires one physical function");
  const roles = functions[0]?.roles ?? [];
  const created = new Map<string, unknown>();
  let store: (ActiveStore & { close?: () => Promise<void> }) | undefined;
  try {
    for (const path of constructionOrder(stack)) {
      const selection = selected.get(path);
      if (!selection) throw new Error(`Missing selection ${path}`);
      const adapter = await load(path, selection, stack, created, roles);
      created.set(path, adapter);
      if (path === "store") {
        store = adapter as ActiveStore & { close?: () => Promise<void> };
        await store.migrate();
      }
    }
    if (!store) throw new Error("Missing active store");
    const kv = created.get("kv") as KV;
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
    const platform = created.get("platform") as {
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
    await store?.close?.();
  }
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
