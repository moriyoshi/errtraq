import {
  type ConstructedAdapter,
  type DeploymentTrigger,
  isEnvRef,
  isInfraRef,
  isVariableRef,
  type StackConfig,
} from "./stack-model.js";
import {
  constructionOrder,
  deriveAccess,
  deriveDeployment,
  resolveStack,
  selections,
} from "./stack-validation.js";

/** The generated entrypoint supplies static imports through this loader. */
export type DeployedModuleLoader = (specifier: string) => Promise<unknown>;
export interface DeployedStack {
  instances: ReadonlyMap<string, unknown>;
  close(): Promise<void>;
}

function configValue(
  value: unknown,
  stack: StackConfig,
  environment: Readonly<Record<string, string | undefined>>,
): unknown {
  if (isEnvRef(value)) {
    if (value.phase !== "runtime")
      throw new Error("Invalid deployed config reference");
    const raw = environment[value.name] ?? value.defaultValue;
    if (raw === undefined)
      throw new Error(`Missing environment variable ${value.name}`);
    const result = raw + (value.suffix ?? "");
    if (value.valueType !== "number") return result;
    const number = Number(result);
    if (!result.trim() || !Number.isFinite(number))
      throw new Error(`Invalid environment variable ${value.name}`);
    return number;
  }
  if (isVariableRef(value)) {
    const raw = environment[`TF_VAR_${value.name}`];
    if (raw === undefined) {
      const fallback = stack.variables?.[value.name]?.default;
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing stack variable ${value.name}`);
    }
    const type = stack.variables?.[value.name]?.type;
    try {
      if (type === "number") {
        const number = Number(raw);
        if (!raw.trim() || !Number.isFinite(number)) throw new Error();
        return number;
      }
      if (type === "bool") {
        if (raw !== "true" && raw !== "false") throw new Error();
        return raw === "true";
      }
      if (type === "json" || type === "string[]") {
        const parsed: unknown = JSON.parse(raw);
        if (type === "json" && (!parsed || typeof parsed !== "object"))
          throw new Error();
        if (
          type === "string[]" &&
          (!Array.isArray(parsed) ||
            !parsed.every((item) => typeof item === "string"))
        )
          throw new Error();
        return parsed;
      }
      return raw;
    } catch {
      throw new Error(`Invalid stack variable ${value.name}`);
    }
  }
  if (isInfraRef(value))
    throw new Error("Unsupported deployed config reference");
  if (Array.isArray(value))
    return value.map((item) => configValue(item, stack, environment));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        configValue(item, stack, environment),
      ]),
    );
  return value;
}

/** Construct just the adapters used by a physical function, using delivered binding names. */
export async function constructDeployedStack(
  input: StackConfig,
  functionId: string,
  environment: Readonly<Record<string, string | undefined>>,
  loadModule: DeployedModuleLoader,
): Promise<DeployedStack> {
  const stack = resolveStack(input);
  const view = deriveDeployment(stack);
  const fn = view.functions.find((item) => item.id === functionId);
  if (!fn) throw new Error(`Unknown physical function ${functionId}`);
  const selected = selections(stack);
  const needed = new Set(
    deriveAccess(stack)
      .grants.filter((grant) => grant.functionId === functionId)
      .map((grant) => grant.selection),
  );
  for (const item of [
    ...fn.envBindings,
    ...fn.secretBindings,
    ...fn.platformBindings,
  ])
    needed.add(item.selection);
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of [...needed]) {
      for (const [child] of selected) {
        if (child.startsWith(`${path}.`) && !needed.has(child)) {
          needed.add(child);
          changed = true;
        }
      }
      for (const target of Object.values(selected.get(path)?.dependsOn ?? {})) {
        if (!needed.has(target)) {
          needed.add(target);
          changed = true;
        }
      }
    }
  }
  const instances = new Map<string, unknown>();
  const closers: ConstructedAdapter[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
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
    })());
  const delivered = (name: string): string => {
    const value = environment[name];
    if (value === undefined)
      throw new Error(`Missing deployed binding ${name}`);
    return value;
  };
  try {
    for (const path of constructionOrder(stack)) {
      if (!needed.has(path)) continue;
      const selection = selected.get(path);
      if (!selection) throw new Error(`Missing selection ${path}`);
      const module = await loadModule(selection.runtimeModule);
      if (
        !module ||
        typeof module !== "object" ||
        !("create" in module) ||
        typeof module.create !== "function"
      )
        throw new Error(`Invalid adapter: ${selection.manifest.id}`);
      const scoped = [
        ...fn.envBindings,
        ...fn.secretBindings,
        ...fn.platformBindings,
      ].filter((item) => item.selection === path);
      if (scoped.some((item) => item.binding.kind === "platform"))
        throw new Error(
          "Platform bindings require a platform-specific deployed runtime",
        );
      const bindings = Object.fromEntries(
        scoped.map((item) => [item.binding.name, delivered(item.binding.name)]),
      );
      const dependencies = Object.fromEntries(
        Object.entries(selection.dependsOn ?? {}).map(([alias, target]) => {
          if (!instances.has(target))
            throw new Error(`Missing runtime dependency ${target}`);
          return [alias, instances.get(target)];
        }),
      );
      const triggers = view.triggers.filter(
        (trigger): trigger is Extract<DeploymentTrigger, { kind: "queue" }> =>
          trigger.kind === "queue" && trigger.functionId === functionId,
      );
      const queueContext =
        selection.manifest.kind === "queue"
          ? {
              topics: Object.fromEntries(
                view.triggers.flatMap((trigger) =>
                  trigger.kind === "queue"
                    ? trigger.topics.map((topic) => [
                        topic,
                        stack.queue.infra.topics?.routes[topic],
                      ])
                    : [],
                ),
              ),
              queueConsumers: triggers.map((trigger) => {
                if (!trigger.eventSourceBinding)
                  throw new Error(
                    `Missing event-source binding for ${trigger.physical}`,
                  );
                return {
                  physical: trigger.physical,
                  topics: trigger.topics,
                  eventSource: delivered(trigger.eventSourceBinding),
                };
              }),
            }
          : {};
      const instance: unknown = await module.create({
        config: configValue(selection.config, stack, environment),
        bindings,
        dependencies,
        ...queueContext,
      });
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
    }
    return { instances, close };
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
