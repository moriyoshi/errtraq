import {
  type AdapterSelection,
  assertImplementedConsumerTopics,
  type ConstructedAdapter,
  constructionOrder,
  deriveTriggers,
  type FunctionRole,
  type StackConfig,
  selections,
} from "@errtraq/core";
import { resolveRoleBindings, resolveRuntimeValue } from "./runtime.js";

type ModuleLoader = (specifier: string) => Promise<unknown>;
export interface ConstructedStack {
  platform: unknown;
  instances: ReadonlyMap<string, unknown>;
  close(): Promise<void>;
}

/** Construct in dependency order and always close every constructed instance in reverse order. */
export async function constructStack(
  stack: StackConfig,
  roles: readonly FunctionRole[],
  environment: Record<string, string | undefined>,
  loadModule: ModuleLoader = (specifier) => import(specifier),
): Promise<ConstructedStack> {
  const selected = selections(stack);
  assertImplementedConsumerTopics(
    deriveTriggers(stack)
      .filter((trigger) => trigger.kind === "queue")
      .flatMap((trigger) => trigger.topics),
  );
  const instances = new Map<string, unknown>();
  const closers: ConstructedAdapter[] = [];
  let platform: unknown;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise)
      closePromise = (async () => {
        const errors: unknown[] = [];
        for (const adapter of [...closers].reverse()) {
          try {
            await adapter.close?.();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, "Adapter cleanup failed");
      })();
    return closePromise;
  };
  try {
    for (const path of constructionOrder(stack)) {
      const selection: AdapterSelection | undefined = selected.get(path);
      if (!selection) throw new Error(`Missing selection ${path}`);
      const module = await loadModule(selection.runtimeModule);
      if (
        !module ||
        typeof module !== "object" ||
        !("create" in module) ||
        typeof module.create !== "function"
      )
        throw new Error(`Invalid adapter: ${selection.manifest.id}`);
      const dependencies = Object.fromEntries(
        Object.entries(selection.dependsOn ?? {}).map(([alias, target]) => {
          if (!instances.has(target))
            throw new Error(`Missing runtime dependency ${target}`);
          return [alias, instances.get(target)];
        }),
      );
      if (selection.manifest.kind === "platform") {
        for (const [name, adapter] of instances) {
          const kind = selected.get(name)?.manifest.kind;
          if (kind && !name.includes(".")) dependencies[kind] = adapter;
        }
      }
      const queueContext =
        selection.manifest.kind === "queue"
          ? {
              topics: Object.fromEntries(
                Object.entries(selection.infra.topics?.routes ?? {}).map(
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
              ),
              queueConsumers: deriveTriggers(stack)
                .filter((trigger) => trigger.kind === "queue")
                .map((trigger) => ({
                  physical: trigger.physical,
                  topics: trigger.topics,
                  eventSource: resolveRuntimeValue(
                    trigger.resource,
                    path,
                    stack,
                    environment,
                  ),
                })),
            }
          : {};
      const context = {
        config: resolveRuntimeValue(selection.config, path, stack, environment),
        bindings: resolveRoleBindings(stack, roles, path, environment),
        dependencies,
        environment,
        secretSource: {
          read: async (identifier: string) => {
            const value = environment[identifier];
            if (value === undefined)
              throw new Error(`Missing local secret: ${identifier}`);
            return value;
          },
        },
        ...queueContext,
        ...(selection.manifest.kind === "platform"
          ? {
              cronJobs: deriveTriggers(stack)
                .filter((trigger) => trigger.kind === "cron")
                .map((trigger) => trigger.name),
            }
          : {}),
      };
      const instance: unknown = await module.create(context);
      instances.set(path, instance);
      if (
        instance &&
        (typeof instance === "object" || typeof instance === "function") &&
        "close" in instance
      ) {
        if (typeof instance.close !== "function")
          throw new Error(`Invalid close method: ${selection.manifest.id}`);
        const closeAdapter = instance.close.bind(instance);
        closers.push({ close: () => closeAdapter() });
      }
      if (selection.manifest.kind === "platform") platform = instance;
    }
    if (!platform) throw new Error("Missing platform adapter");
    return { platform, instances, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Construction and cleanup failed",
      );
    }
    throw error;
  }
}
