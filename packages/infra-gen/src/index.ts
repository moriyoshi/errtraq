import {
  deriveDeployment,
  escapeTerraformLiteral,
  type InfraValue,
  isArtifactRef,
  isConfigBindingRef,
  isEnvRef,
  isInfraRef,
  isOutputRef,
  isStackRef,
  isVariableRef,
  moduleName,
  output,
  type ResolvedStack,
  resolveStack,
  selections,
  terraformVariableType,
} from "@errtraq/core";

export interface GenerateOptions {
  /** POSIX paths, either both absolute or both relative to the same root. */
  outputDirectory: string;
  modulesDirectory: string;
  generationEnv: Readonly<Record<string, string | undefined>>;
  /** Per-function ZIP paths relative to the generated Terraform root. */
  artifactPaths: Readonly<Record<string, string | undefined>>;
}
export type GeneratedFileSet = Readonly<Record<string, string>>;
export type GenerationResult =
  | { kind: "terraform"; files: GeneratedFileSet }
  | { kind: "not-applicable"; reason: string };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key] ?? null)]),
    );
  return value;
}
function serialize(value: Json): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}
function directoryParts(path: string): { absolute: boolean; parts: string[] } {
  if (!path || path.includes("\\"))
    throw new Error("Directories must be nonempty POSIX paths");
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("Directory escapes its common root");
      parts.pop();
    } else parts.push(part);
  }
  return { absolute, parts };
}
/** Calculate a module source without consulting the working directory. */
export function relativeModuleSource(
  outputDirectory: string,
  modulesDirectory: string,
  provider: string,
  component: string,
): string {
  const from = directoryParts(outputDirectory);
  const to = directoryParts(modulesDirectory);
  if (from.absolute !== to.absolute)
    throw new Error(
      "Output and module directories must use the same path root",
    );
  let common = 0;
  while (
    common < from.parts.length &&
    common < to.parts.length &&
    from.parts[common] === to.parts[common]
  )
    common++;
  const parts = [
    ...Array.from({ length: from.parts.length - common }, () => ".."),
    ...to.parts.slice(common),
    provider,
    component,
  ];
  const result = parts.join("/");
  return result.startsWith("../") || result.startsWith("./")
    ? result
    : `./${result}`;
}
function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}
function indexPath(path: readonly string[]): string {
  return path.map((key) => `[${JSON.stringify(key)}]`).join("");
}
function variableExpression(stack: ResolvedStack, name: string): string {
  const declaration = own(stack.variables, name);
  if (!declaration) throw new Error(`Unknown variable ${name}`);
  return declaration.type === "json"
    ? `jsondecode(var.${name})`
    : `var.${name}`;
}

/** Render one infrastructure value; reference objects remain in-process until this point. */
export function renderInfraValue(
  value: InfraValue,
  owner: string,
  stack: ResolvedStack,
  options: GenerateOptions,
): Json {
  const all = selections(stack);
  const seen = new Set<string>();
  function render(current: InfraValue, currentOwner: string): Json {
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "number"
    )
      return current;
    if (typeof current === "string") return escapeTerraformLiteral(current);
    if (Array.isArray(current))
      return current.map((item) => render(item, currentOwner));
    if (isConfigBindingRef(current)) {
      const ref = current.source;
      if (isEnvRef(ref)) return `\${var.errtraq_env_${ref.name}}`;
      const declaration = own(stack.variables, ref.name);
      if (!declaration) throw new Error(`Unknown variable ${ref.name}`);
      const expression =
        declaration.type === "string[]"
          ? `jsonencode(var.${ref.name})`
          : declaration.type === "number" || declaration.type === "bool"
            ? `tostring(var.${ref.name})`
            : `var.${ref.name}`;
      return `\${${expression}}`;
    }
    if (isOutputRef(current)) {
      const target = current.selection ?? currentOwner;
      const selection = all.get(target);
      if (!selection) throw new Error(`Unknown selection ${target}`);
      if (!selection.existing)
        return `\${module.${moduleName(target)}.${current.name}${indexPath(current.path ?? [])}}`;
      const label = [target, current.name, ...(current.path ?? [])].join(".");
      if (seen.has(label)) throw new Error(`Existing output cycle at ${label}`);
      seen.add(label);
      let replacement = own(selection.existing, current.name);
      if (replacement === undefined)
        throw new Error(`Missing existing output ${label}`);
      const path = current.path ?? [];
      for (let index = 0; index < path.length; index++) {
        const key = path[index];
        if (key === undefined)
          throw new Error(`Invalid existing output path ${label}`);
        if (isOutputRef(replacement)) {
          const next = output(
            replacement.selection ?? target,
            replacement.name,
            ...(replacement.path ?? []),
            ...path.slice(index),
          );
          const result = render(next, target);
          seen.delete(label);
          return result;
        }
        if (isVariableRef(replacement)) {
          const result = `\${${variableExpression(stack, replacement.name)}${indexPath(path.slice(index))}}`;
          seen.delete(label);
          return result;
        }
        if (
          !replacement ||
          typeof replacement !== "object" ||
          Array.isArray(replacement) ||
          isInfraRef(replacement)
        )
          throw new Error(`Cannot index existing output ${label}`);
        const next: InfraValue | undefined = own(replacement, key);
        if (next === undefined)
          throw new Error(`Missing existing output key ${label}`);
        replacement = next;
      }
      const result = render(replacement, target);
      seen.delete(label);
      return result;
    }
    if (isStackRef(current)) {
      if (current.name === "name") return escapeTerraformLiteral(stack.name);
      if (current.name === "protection")
        return stack.protection ?? "production";
      const provider =
        current.provider ??
        all.get(currentOwner)?.provider ??
        all.get(currentOwner)?.infra.module.provider;
      const entry = provider ? own(stack.providers, provider) : undefined;
      if (!entry) throw new Error(`Unknown provider ${provider ?? ""}`);
      if (current.name === "region") {
        if (!entry.region)
          throw new Error(`Provider ${provider} region is missing`);
        return escapeTerraformLiteral(entry.region);
      }
      return Object.fromEntries(
        Object.entries(entry.tags ?? {}).map(([key, val]) => [
          escapeTerraformLiteral(key),
          escapeTerraformLiteral(val),
        ]),
      );
    }
    if (isVariableRef(current))
      return `\${${variableExpression(stack, current.name)}}`;
    if (isEnvRef(current)) {
      if (current.phase !== "generate")
        throw new Error(
          `Runtime environment ${current.name} cannot be rendered during generation`,
        );
      const value = own(options.generationEnv, current.name);
      if (value === undefined)
        throw new Error(`Missing generation environment ${current.name}`);
      return escapeTerraformLiteral(value);
    }
    if (isArtifactRef(current)) {
      const path = own(options.artifactPaths, current.functionId);
      if (!path)
        throw new Error(`Missing artifact path for ${current.functionId}`);
      if (path.startsWith("/") || path.includes("\\"))
        throw new Error(
          `Artifact path for ${current.functionId} must be relative and POSIX`,
        );
      return escapeTerraformLiteral(path);
    }
    return Object.fromEntries(
      Object.entries(current).map(([key, item]) => [
        escapeTerraformLiteral(key),
        render(item, currentOwner),
      ]),
    );
  }
  return render(value, owner);
}

const MIN_AWS = ">= 6.32.1, < 7.0";
const REQUIRED_VERSION = ">= 1.9.0, < 2.0.0";
const MODULE_META = new Set([
  "source",
  "version",
  "providers",
  "depends_on",
  "count",
  "for_each",
]);
function family(source: string): string {
  const name = source.split("/").at(-1) ?? "";
  if (!/^[a-z][a-z0-9_-]*$/.test(name))
    throw new Error(`Invalid provider source ${source}`);
  return name;
}
function providerConfig(stack: ResolvedStack): {
  required: Record<string, Json>;
  providers: Record<string, Json>;
} {
  const groups = new Map<
    string,
    { source: string; versions: Set<string>; blocks: Json[] }
  >();
  for (const [key, provider] of Object.entries(stack.providers ?? {}).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const name = family(provider.source);
    let group = groups.get(name);
    if (!group) {
      group = { source: provider.source, versions: new Set(), blocks: [] };
      groups.set(name, group);
    }
    if (group.source !== provider.source)
      throw new Error(`Provider family ${name} has conflicting sources`);
    group.versions.add(provider.version);
    if (name === "aws") group.versions.add(MIN_AWS);
    if (
      name !== "aws" &&
      (provider.region || Object.keys(provider.tags ?? {}).length)
    )
      throw new Error(
        `Provider ${name} region and tags mapping is not implemented`,
      );
    const tags = Object.fromEntries(
      Object.entries(provider.tags ?? {}).map(([tag, value]) => [
        escapeTerraformLiteral(tag),
        escapeTerraformLiteral(value),
      ]),
    );
    group.blocks.push({
      ...(key === name ? {} : { alias: key }),
      ...(provider.region
        ? { region: escapeTerraformLiteral(provider.region) }
        : {}),
      ...(Object.keys(tags).length ? { default_tags: { tags } } : {}),
    });
  }
  const required: Record<string, Json> = Object.create(null);
  const providers: Record<string, Json> = Object.create(null);
  for (const [name, group] of [...groups].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const versions = [...group.versions].sort();
    required[name] = { source: group.source, version: versions.join(", ") };
    providers[name] = group.blocks;
  }
  return { required, providers };
}
function jsonValue(value: InfraValue): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isInfraRef(value))
    throw new Error("Variable defaults must be literal values");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
  );
}
function variableFiles(
  stack: ResolvedStack,
  deployment: ReturnType<typeof deriveDeployment>,
): {
  variables: Record<string, Json>;
  tfvars: Record<string, Json>;
} {
  const variables: Record<string, Json> = Object.create(null);
  const tfvars: Record<string, Json> = Object.create(null);
  for (const [name, declaration] of Object.entries(stack.variables ?? {})) {
    const variable: Record<string, Json> = {
      type: terraformVariableType(declaration.type),
      sensitive: declaration.sensitive,
    };
    if (declaration.type === "json") {
      const decoded = `jsonencode(jsondecode(var.${name}))`;
      variable.validation = [
        {
          condition: `\${can(jsondecode(var.${name})) ? (startswith(${decoded}, "{") || startswith(${decoded}, "[")) : false}`,
          error_message: `${name} must contain a JSON object or array`,
        },
      ];
    }
    if (declaration.default !== undefined) {
      if (declaration.sensitive)
        throw new Error(`Sensitive variable ${name} cannot have a default`);
      const data = canonical(jsonValue(declaration.default));
      const literal = declaration.type === "json" ? JSON.stringify(data) : data;
      variable.default = literal;
      tfvars[name] = literal;
    }
    variables[name] = variable;
  }
  for (const fn of deployment.functions)
    for (const item of fn.envBindings) {
      const ref = item.binding.value;
      if (!isConfigBindingRef(ref) || !isEnvRef(ref.source)) continue;
      const name = `errtraq_env_${ref.source.name}`;
      if (Object.hasOwn(stack.variables ?? {}, name))
        throw new Error(
          `Runtime environment variable ${ref.source.name} conflicts with stack variable ${name}`,
        );
      const definition: Record<string, Json> = {
        type: "string",
        sensitive: false,
      };
      if (ref.source.defaultValue !== undefined)
        definition.default = escapeTerraformLiteral(ref.source.defaultValue);
      if (
        variables[name] &&
        JSON.stringify(variables[name]) !== JSON.stringify(definition)
      )
        throw new Error(
          `Conflicting defaults for runtime environment ${ref.source.name}`,
        );
      variables[name] = definition;
    }
  return { variables, tfvars };
}

/** Compose validated descriptors into deterministic Terraform JSON without I/O. */
export function generate(
  stack: ResolvedStack,
  options: GenerateOptions,
): GenerationResult {
  if (resolveStack(stack) !== stack)
    throw new Error("Expected a resolved stack");
  if (stack.platform.manifest.id === "standalone")
    return {
      kind: "not-applicable",
      reason: "The standalone platform has no Terraform infrastructure.",
    };
  const all = selections(stack);
  const deployment = deriveDeployment(stack);
  const modules: Record<string, Json> = Object.create(null);
  for (const [path, selection] of [...all].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (selection.existing) continue;
    const { provider, component } = selection.infra.module;
    if (provider === "local")
      throw new Error(`No Terraform module for local selection ${path}`);
    const source = relativeModuleSource(
      options.outputDirectory,
      options.modulesDirectory,
      provider,
      component,
    );
    const block: Record<string, Json> = Object.assign(Object.create(null), {
      source,
    });
    const providerKey = selection.provider ?? provider;
    if (providerKey !== provider)
      block.providers = { [provider]: `${provider}.${providerKey}` };
    const inputs = selection.infra.inputs(selection.config, deployment);
    for (const [key, value] of Object.entries(inputs)) {
      if (MODULE_META.has(key))
        throw new Error(
          `Module input ${path}.${key} conflicts with Terraform metadata`,
        );
      block[escapeTerraformLiteral(key)] = renderInfraValue(
        value,
        path,
        stack,
        options,
      );
    }
    modules[moduleName(path)] = block;
  }
  const { required, providers } = providerConfig(stack);
  const { variables, tfvars } = variableFiles(stack, deployment);
  const header = `Generated by errtraq from stack ${stack.name}; do not edit.`;
  const files: Record<string, string> = {
    "main.tf.json": serialize({ "//": header, module: modules }),
    "variables.tf.json": serialize({
      "//": header,
      ...(Object.keys(variables).length ? { variable: variables } : {}),
    }),
    "providers.tf.json": serialize({
      "//": header,
      terraform: {
        required_version: REQUIRED_VERSION,
        required_providers: required,
      },
      provider: providers,
    }),
    "outputs.tf.json": serialize({
      "//": header,
      ...(Object.keys(stack.outputs ?? {}).length
        ? {
            output: Object.fromEntries(
              Object.entries(stack.outputs ?? {}).map(([name, value]) => [
                name,
                { value: renderInfraValue(value, "platform", stack, options) },
              ]),
            ),
          }
        : {}),
    }),
  };
  if (Object.keys(tfvars).length)
    files["terraform.tfvars.json"] = serialize({ "//": header, ...tfvars });
  if (stack.backend)
    files["backend.tf.json"] = serialize({
      "//": header,
      terraform: {
        backend: {
          [stack.backend.type]: renderInfraValue(
            stack.backend.config,
            "platform",
            stack,
            options,
          ),
        },
      },
    });
  return {
    kind: "terraform",
    files: Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
}
