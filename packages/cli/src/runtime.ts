import {
  bindingsForRoles,
  type FunctionRole,
  isEnvRef,
  isInfraRef,
  isOutputRef,
  isStackRef,
  isVariableRef,
  output,
  type StackConfig,
  selections,
} from "@errtraq/core";

/** Only resolve bindings the requested roles actually use. */
export function resolveRoleBindings(
  stack: StackConfig,
  roles: readonly FunctionRole[],
  selection: string,
  environment: Record<string, string | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    bindingsForRoles(stack, roles)
      .filter((item) => item.selection === selection)
      .map(({ binding }) => [
        binding.name,
        resolveRuntimeValue(binding.value, selection, stack, environment),
      ]),
  );
}

/** Resolve runtime bindings and existing substitutions without printing their values. */
export function resolveRuntimeValue(
  value: unknown,
  owner: string,
  stack: StackConfig,
  environment: Record<string, string | undefined>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) =>
      resolveRuntimeValue(item, owner, stack, environment),
    );
  if (isStackRef(value)) {
    if (value.name === "name") return stack.name;
    const provider =
      value.provider ?? selections(stack).get(owner)?.infra.module.provider;
    const entry =
      provider && Object.hasOwn(stack.providers ?? {}, provider)
        ? stack.providers?.[provider]
        : undefined;
    if (!entry) throw new Error(`Unknown provider ${provider ?? ""}`);
    return value.name === "region" ? entry.region : (entry.tags ?? {});
  }
  if (isEnvRef(value)) {
    const raw = environment[value.name] ?? value.defaultValue;
    if (raw === undefined)
      throw new Error(`Missing environment variable ${value.name}`);
    const result = raw + (value.suffix ?? "");
    if (value.valueType === "number") {
      const number = Number(result);
      if (!result.trim() || !Number.isFinite(number))
        throw new Error(`Invalid environment variable ${value.name}`);
      return number;
    }
    return result;
  }
  if (isVariableRef(value)) {
    const raw = environment[`TF_VAR_${value.name}`];
    if (raw === undefined)
      throw new Error(`Missing stack variable ${value.name}`);
    const type = stack.variables?.[value.name]?.type;
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
      throw new Error(`Invalid stack variable ${value.name}`);
    }
  }
  if (isOutputRef(value)) {
    const target = value.selection ?? owner;
    const replacement = selections(stack).get(target)?.existing?.[value.name];
    if (replacement === undefined)
      throw new Error(
        `Output ${target}.${value.name} is not available in local runtime`,
      );
    if (isOutputRef(replacement))
      return resolveRuntimeValue(
        output(
          replacement.selection ?? target,
          replacement.name,
          ...(replacement.path ?? []),
          ...(value.path ?? []),
        ),
        target,
        stack,
        environment,
      );
    let result: unknown = replacement;
    for (const key of value.path ?? []) {
      if (isInfraRef(result))
        result = resolveRuntimeValue(result, target, stack, environment);
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !Object.hasOwn(result, key)
      )
        throw new Error(
          `Output ${target}.${value.name}.${key} is not available in local runtime`,
        );
      result = Object.getOwnPropertyDescriptor(result, key)?.value;
    }
    return resolveRuntimeValue(result, target, stack, environment);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveRuntimeValue(item, owner, stack, environment),
    ]),
  );
}
