import {
  deriveAccess,
  deriveDeployment,
  type ResolvedStack,
  selections,
} from "@errtraq/core";

/** Format only names and structural relationships; never render binding values. */
export function formatValidation(stack: ResolvedStack): string {
  const lines: string[] = [];
  lines.push(`Valid stack: ${stack.name}`);
  for (const [path, selection] of selections(stack))
    lines.push(`Selection ${path}: ${selection.manifest.id}`);
  const view = deriveDeployment(stack);
  const access = deriveAccess(stack);
  for (const fn of view.functions) {
    lines.push(`Function ${fn.id}: ${fn.roles.join(", ")}`);
    lines.push(
      `  Bindings: ${[...fn.envBindings, ...fn.secretBindings, ...fn.platformBindings].map(({ binding }) => binding.name).join(", ") || "none"}`,
    );
    lines.push(
      `  Capabilities: ${
        access.grants
          .filter((grant) => grant.functionId === fn.id)
          .map(
            (grant) =>
              `${grant.selection}.${grant.capability}.${grant.purpose}`,
          )
          .join(", ") || "none"
      }`,
    );
  }
  for (const trigger of view.triggers)
    lines.push(
      trigger.kind === "queue"
        ? `Topics ${trigger.topics.join(", ")}: ${trigger.physical} -> ${trigger.functionId}`
        : `Cron ${trigger.name}: ${trigger.schedule} -> ${trigger.functionId}`,
    );
  return lines.join("\n");
}
