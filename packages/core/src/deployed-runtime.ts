import {
  constructDeployedPlan,
  type DeployedModuleLoader,
  type DeployedPlan,
  type DeployedStack,
} from "./deployed-execution.js";
import type { Logger, SecretSource } from "./ports.js";
import { isConfigBindingRef, type StackConfig } from "./stack-model.js";
import {
  constructionOrder,
  deriveAccess,
  deriveDeployment,
  resolveStack,
  selections,
} from "./stack-validation.js";

export type {
  DeployedModuleLoader,
  DeployedPlan,
  DeployedStack,
} from "./deployed-execution.js";
export { constructDeployedPlan } from "./deployed-execution.js";

/** Derive everything a function needs before emitting its static entrypoint. */
export function deployedPlan(
  input: StackConfig,
  functionId: string,
): DeployedPlan {
  const stack = resolveStack(input);
  const view = deriveDeployment(stack);
  const fn = view.functions.find((item) => item.id === functionId);
  if (!fn) throw new Error(`Unknown physical function ${functionId}`);
  const selected = selections(stack);
  const scoped = [
    ...fn.envBindings,
    ...fn.secretBindings,
    ...fn.platformBindings,
  ];
  const needed = new Set(
    deriveAccess(stack)
      .grants.filter((grant) => grant.functionId === functionId)
      .map((grant) => grant.selection),
  );
  for (const item of scoped)
    if (item.selection !== "platform") needed.add(item.selection);
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of [...needed]) {
      for (const [child] of selected)
        if (child.startsWith(`${path}.`) && !needed.has(child)) {
          needed.add(child);
          changed = true;
        }
      for (const target of Object.values(selected.get(path)?.dependsOn ?? {}))
        if (!needed.has(target)) {
          needed.add(target);
          changed = true;
        }
    }
  }
  const ordered = constructionOrder(stack)
    .filter((path) => needed.has(path))
    .map((path) => {
      const selection = selected.get(path);
      if (!selection) throw new Error(`Missing selection ${path}`);
      return {
        path,
        id: selection.manifest.id,
        kind: selection.manifest.kind,
        runtimeModule: selection.runtimeModule,
        config: selection.config,
        dependsOn: selection.dependsOn ?? {},
        bindings: scoped
          .filter((item) => item.selection === path)
          .map(({ binding }) => ({
            name: binding.name,
            kind: binding.kind,
            ...(isConfigBindingRef(binding.value) ? { allowEmpty: true } : {}),
          })),
      };
    });
  const queueTriggers = view.triggers.filter(
    (trigger) => trigger.kind === "queue",
  );
  const topics = Object.fromEntries(
    queueTriggers.flatMap((trigger) =>
      trigger.topics.map((topic) => [
        topic,
        stack.queue.infra.topics?.routes[topic],
      ]),
    ),
  );
  const queueConsumers = queueTriggers
    .filter((trigger) => trigger.functionId === functionId)
    .map((trigger) => {
      if (!trigger.eventSourceBinding)
        throw new Error(`Missing event-source binding for ${trigger.physical}`);
      return {
        physical: trigger.physical,
        topics: trigger.topics,
        eventSourceBinding: trigger.eventSourceBinding,
      };
    });
  return {
    recordMode: stack.recordMode ?? "direct",
    ...(stack.rateRejection ? { rateRejection: stack.rateRejection } : {}),
    variables: stack.variables,
    selections: ordered,
    topics,
    queueConsumers,
  };
}

/** Construct just the adapters used by a physical function, using delivered binding names. */
export function constructDeployedStack(
  input: StackConfig,
  functionId: string,
  environment: Readonly<Record<string, string | undefined>>,
  loadModule: DeployedModuleLoader,
  logger?: Logger,
  secretSource?: SecretSource,
): Promise<DeployedStack> {
  return constructDeployedPlan(
    deployedPlan(input, functionId),
    environment,
    loadModule,
    logger,
    secretSource,
  );
}
