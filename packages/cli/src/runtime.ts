import {
  type EnvRef,
  type InfraValue,
  type OutputRef,
  type StackConfig,
  type StackRef,
  selections,
  type VariableRef,
} from "@errtraq/core";

/** Resolve runtime bindings and existing substitutions without printing their values. */
export function resolveRuntimeValue(
  value: InfraValue,
  owner: string,
  stack: StackConfig,
  environment: Record<string, string | undefined>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) =>
      resolveRuntimeValue(item, owner, stack, environment),
    );
  if ("kind" in value) {
    const ref = value as OutputRef | EnvRef | VariableRef | StackRef;
    if (ref.kind === "stack")
      return ref.name === "name"
        ? stack.name
        : ref.name === "region"
          ? stack.region
          : (stack.tags ?? {});
    if (ref.kind === "env") {
      const result = environment[ref.name];
      if (result === undefined)
        throw new Error(`Missing environment variable ${ref.name}`);
      return result;
    }
    if (ref.kind === "variable") {
      const raw = environment[`TF_VAR_${ref.name}`];
      if (raw === undefined)
        throw new Error(`Missing stack variable ${ref.name}`);
      const type = stack.variables?.[ref.name]?.type;
      try {
        if (type === "number") {
          const n = Number(raw);
          if (!Number.isFinite(n) || !raw.trim()) throw new Error();
          return n;
        }
        if (type === "bool") {
          if (raw !== "true" && raw !== "false") throw new Error();
          return raw === "true";
        }
        if (type === "string[]" || type === "json") {
          const parsed: unknown = JSON.parse(raw);
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
        throw new Error(`Invalid stack variable ${ref.name}`);
      }
    }
    if (ref.kind === "output") {
      const target = ref.selection ?? owner;
      const replacement = selections(stack).get(target)?.existing?.[ref.name];
      if (replacement === undefined)
        throw new Error(
          `Output ${target}.${ref.name} is not available in local runtime`,
        );
      return resolveRuntimeValue(replacement, target, stack, environment);
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveRuntimeValue(item, owner, stack, environment),
    ]),
  );
}
