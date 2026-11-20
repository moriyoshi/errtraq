function ownValue<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

import {
  type AdapterSelection,
  type CoreTopic,
  CRON_JOBS,
  FUNCTION_ROLES,
  type FunctionRole,
  type FunctionSettings,
  type InfraValue,
  isEnvRef,
  isInfraRef,
  isOutputRef,
  isStackRef,
  isVariableRef,
  type OutputRef,
  type OutputType,
  type PhysicalFunction,
  type PlatformConfig,
  REF,
  type StackConfig,
  type StackValidationIssue,
  TOPICS,
} from "./stack-model.js";
import {
  platformConfigSchema,
  platformSchema,
  requiredCapabilities,
  rootSchema,
} from "./stack-schema.js";

// A resolved stack has already passed all checks, including potentially transforming
// adapter schemas. Keep its construction order alongside its identity.
const resolvedOrders = new WeakMap<StackConfig, string[]>();
declare const resolvedBrand: unique symbol;
export type ResolvedStack = StackConfig & { readonly [resolvedBrand]: true };

// Clone only data objects; schemas are shared, executable objects owned by adapters.
// Never freeze an input object supplied by the caller.
function frozenSnapshot<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    return value;
  const previous = seen.get(value);
  if (previous) return previous as T;
  const copy: object = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      Object.defineProperty(copy, key, {
        value: frozenSnapshot(descriptor.value, seen),
        enumerable: descriptor.enumerable,
        writable: false,
        configurable: false,
      });
    }
  }
  return Object.freeze(copy) as T;
}

/** Flatten all selected modules using stable, qualified selection paths. */
export function selections(stack: StackConfig): Map<string, AdapterSelection> {
  const result = new Map<string, AdapterSelection>();
  function add(path: string, selection: AdapterSelection) {
    result.set(path, selection);
    for (const [key, child] of Object.entries(selection.children ?? {}).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    ))
      add(`${path}.${key}`, child);
  }
  for (const key of [
    "platform",
    "store",
    "queue",
    "blob",
    "archive",
    "kv",
  ] as const) {
    const selection = stack[key];
    if (selection) add(key, selection);
  }
  return result;
}
/** Split roles use their role name as id; all remaining roles share id `shared`.
 * Roles and functions follow FUNCTION_ROLES order, independent of input order.
 * Disjoint per-role settings merge; different values for the same setting conflict.
 */
export function physicalFunctions(config: PlatformConfig): PhysicalFunction[] {
  if (!platformConfigSchema.safeParse(config).success)
    throw new Error("Invalid platform function configuration");
  const roles = FUNCTION_ROLES.filter((role) => config.roles.includes(role));
  const groups = roles
    .filter((role) => config.split.includes(role))
    .map((role) => ({ id: role as string, roles: [role] }));
  const shared = roles.filter((role) => !config.split.includes(role));
  if (shared.length) groups.push({ id: "shared", roles: shared });
  return groups.map(({ id, roles: groupRoles }) => {
    const settings: FunctionSettings = {};
    for (const role of groupRoles) {
      for (const [key, value] of Object.entries(
        config.settings?.[role] ?? {},
      )) {
        const previous = Object.getOwnPropertyDescriptor(settings, key)?.value;
        if (
          previous !== undefined &&
          JSON.stringify(previous) !== JSON.stringify(value)
        )
          throw new Error(`Conflicting ${key} settings in function ${id}`);
        Object.defineProperty(settings, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return { id, roles: groupRoles, settings };
  });
}
function inspect(input: unknown): {
  issues: StackValidationIssue[];
  resolved?: StackConfig;
  order?: string[];
} {
  const parsed = rootSchema.safeParse(input);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  const stack = parsed.data as StackConfig;
  const issues: StackValidationIssue[] = [];
  const fail = (path: string, message: string) =>
    issues.push({ path, message });
  const platformParsed = platformSchema.safeParse(stack.platform.manifest);
  if (!platformParsed.success) {
    fail("platform.manifest", "Invalid platform manifest");
    return { issues };
  }
  const platform = platformParsed.data;
  if (
    ownValue(stack.providers, "aws") &&
    !ownValue(stack.providers, "aws")?.region
  )
    fail("providers.aws.region", "Region is required for the AWS provider");
  const all = selections(stack);
  const rawConfigs = new Map<string, unknown>();
  const graph = new Map<string, Set<string>>();
  const moduleGraph = new Map<string, Set<string>>();
  for (const path of all.keys()) {
    graph.set(path, new Set());
    moduleGraph.set(path, new Set());
  }
  for (const [path, sel] of all) {
    rawConfigs.set(path, sel.config);
    if (!path.includes(".") && sel.manifest.kind !== path)
      fail(path, `Expected ${path} adapter`);
    if (!sel.manifest.runtimes.includes(platform.runtime))
      fail(
        path,
        `Adapter ${sel.manifest.id} does not support runtime ${platform.runtime}`,
      );
    for (const [cap, schema] of Object.entries(
      requiredCapabilities[sel.manifest.kind] ?? {},
    ))
      if (!schema.safeParse(ownValue(sel.manifest.capabilities, cap)).success)
        fail(
          `${path}.manifest.capabilities.${cap}`,
          "Missing or invalid capability",
        );
    try {
      const config = sel.manifest.configSchema.safeParse(sel.config);
      if (!config.success)
        for (const i of config.error.issues)
          fail([path, "config", ...i.path].join("."), i.message);
      else sel.config = config.data;
    } catch (error) {
      fail(`${path}.config`, `Config validation failed: ${String(error)}`);
    }
    if (
      sel.infra.module.provider !== "local" &&
      !ownValue(stack.providers, sel.infra.module.provider)
    )
      fail(`${path}.infra.module.provider`, "Missing provider requirement");
    for (const [alias, target] of Object.entries(sel.dependsOn ?? {})) {
      if (!all.has(target))
        fail(`${path}.dependsOn.${alias}`, "Unknown selection");
      else graph.get(path)?.add(target);
    }
  }
  const cfg = platformConfigSchema.safeParse(stack.platform.config);
  if (!cfg.success) {
    fail("platform.config", "Invalid platform function configuration");
    return { issues };
  }
  const functions = cfg.data as PlatformConfig;
  if (
    new Set(functions.roles).size !== functions.roles.length ||
    new Set(functions.split).size !== functions.split.length
  )
    fail("platform.config.roles", "Duplicate function role");
  for (const roleName of functions.split)
    if (!functions.roles.includes(roleName))
      fail("platform.config.split", `Unknown deployed role ${roleName}`);
  for (const roleName of Object.keys(functions.settings ?? {}))
    if (!functions.roles.includes(roleName as FunctionRole))
      fail("platform.config.settings", `Unknown deployed role ${roleName}`);
  const roleExists = (r: FunctionRole, path: string) => {
    if (!functions.roles.includes(r))
      fail(path, `Platform does not deploy ${r}`);
  };
  const checkValue = (
    value: unknown,
    owner: string,
    path: string,
    allowRuntime: boolean,
    seen = new Set<object>(),
    configMode = false,
  ) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || seen.has(value)) {
      fail(path, "Invalid infrastructure value");
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        checkValue(item, owner, `${path}.${i}`, allowRuntime, seen, configMode);
      });
      seen.delete(value);
      return;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      fail(path, "Expected a plain serializable object");
      seen.delete(value);
      return;
    }
    if (REF in value) {
      const keys = Object.keys(value).sort();
      if (
        configMode &&
        !(
          isVariableRef(value) ||
          (isEnvRef(value) && value.phase === "runtime")
        )
      )
        fail(
          path,
          "Only runtime environment and variable references are allowed in config",
        );
      if (
        isOutputRef(value) &&
        keys.every((k) => ["name", "selection"].includes(k)) &&
        typeof value.name === "string" &&
        value.name &&
        (value.selection === undefined || typeof value.selection === "string")
      ) {
        const target = value.selection ?? owner;
        const selected = all.get(target);
        if (!selected) fail(path, `Unknown selection ${target}`);
        else if (!Object.hasOwn(selected.infra.module.outputs, value.name))
          fail(path, `Unknown output ${target}.${value.name}`);
        else if (
          selected.existing &&
          !Object.hasOwn(selected.existing, value.name)
        )
          fail(path, `Missing existing output ${target}.${value.name}`);
        if (
          target !== owner &&
          selected &&
          (path.includes(".infra.inputs") || path.includes(".existing."))
        )
          moduleGraph.get(owner)?.add(target);
        if (target === owner && path.includes(".existing."))
          fail(path, "Existing value cannot refer to its own output");
        if (target === owner && path.includes(".infra.inputs"))
          fail(path, "Module input cannot reference its own output");
      } else if (
        isStackRef(value) &&
        keys.every((k) => ["name", "provider"].includes(k)) &&
        ["name", "region", "tags"].includes(value.name)
      ) {
        if (value.name === "name" && value.provider !== undefined)
          fail(path, "Stack name is not provider-qualified");
        if (value.name !== "name") {
          const provider =
            value.provider ?? all.get(owner)?.infra.module.provider;
          const entry = provider
            ? ownValue(stack.providers, provider)
            : undefined;
          if (!entry) fail(path, `Unknown provider ${provider ?? ""}`);
          else if (value.name === "region" && !entry.region)
            fail(path, `Provider ${provider} region is missing`);
        }
      } else if (
        isVariableRef(value) &&
        keys.length === 1 &&
        keys[0] === "name" &&
        typeof value.name === "string"
      ) {
        if (!ownValue(stack.variables, value.name))
          fail(path, `Unknown variable ${value.name}`);
      } else if (
        isEnvRef(value) &&
        keys.every((k) =>
          ["name", "phase", "defaultValue", "suffix", "valueType"].includes(k),
        ) &&
        typeof value.name === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.name) &&
        ["runtime", "generate"].includes(value.phase) &&
        (value.defaultValue === undefined ||
          typeof value.defaultValue === "string") &&
        (value.suffix === undefined || typeof value.suffix === "string") &&
        (value.valueType === undefined || value.valueType === "number") &&
        (value.phase === "runtime" ||
          (value.defaultValue === undefined &&
            value.suffix === undefined &&
            value.valueType === undefined))
      ) {
        if (value.phase === "runtime" && !allowRuntime)
          fail(
            path,
            "Runtime environment reference cannot resolve during generation",
          );
      } else fail(path, "Invalid reference");
    } else {
      for (const [k, v] of Object.entries(value))
        checkValue(v, owner, `${path}.${k}`, allowRuntime, seen, configMode);
    }
    seen.delete(value);
  };
  if (stack.backend) {
    checkValue(stack.backend.config, "platform", "backend.config", false);
    const checkBackend = (value: InfraValue, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          checkBackend(item, `${path}.${index}`);
        });
        return;
      }
      if (!value || typeof value !== "object") return;
      if (isInfraRef(value)) {
        if (!isEnvRef(value) || value.phase !== "generate")
          fail(
            path,
            "Backend config requires literals or generation environment references",
          );
        return;
      }
      for (const [key, item] of Object.entries(value))
        checkBackend(item, `${path}.${key}`);
    };
    checkBackend(stack.backend.config, "backend.config");
  }
  function existingTypeCompatible(
    value: InfraValue,
    expected: OutputType,
    owner: string,
  ): boolean {
    if (isOutputRef(value)) {
      const actual = ownValue(
        all.get(value.selection ?? owner)?.infra.module.outputs,
        value.name,
      );
      return !actual || actual === expected;
    }
    if (isStackRef(value))
      return value.name === "tags"
        ? expected === "json"
        : expected === "string" || expected === "json";
    if (isEnvRef(value))
      return (
        expected === "string" ||
        expected === "json" ||
        expected === "secret-ref"
      );
    if (isVariableRef(value)) {
      const type = ownValue(stack.variables, value.name)?.type;
      return (
        !type ||
        (expected === "string" && type === "string") ||
        (expected === "string[]" && type === "string[]") ||
        (expected === "secret-ref" && type === "string") ||
        (expected === "json" && (type === "json" || type === "string"))
      );
    }
    if (expected === "string" || expected === "secret-ref")
      return typeof value === "string";
    if (expected === "string[]")
      return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
    return (
      typeof value === "string" ||
      (!!value && typeof value === "object" && !Array.isArray(value))
    );
  }
  let groups: PhysicalFunction[] = [];
  try {
    groups = physicalFunctions(functions);
  } catch (error) {
    fail("platform.config.settings", String(error));
  }
  if (
    platform.authorization === "none" &&
    (platform.compute !== "long-lived" || groups.length !== 1)
  )
    fail(
      "platform.manifest.authorization",
      "No authorization requires a single long-lived process",
    );
  for (const [path, sel] of all) {
    for (const feature of sel.manifest.requires) {
      if (
        !platform.provides.includes(feature) ||
        (feature === "long-lived-process" &&
          platform.compute !== "long-lived") ||
        (feature === "shared-process-state" &&
          (platform.compute !== "long-lived" || groups.length !== 1))
      )
        fail(
          `${path}.manifest.requires`,
          `Platform does not provide ${feature}`,
        );
    }
  }
  const names = new Map<string, string>();
  for (const [path, sel] of all) {
    // Inspect before parsing as well: a coercion or transform must not hide a
    // reference that is illegal in config.
    checkValue(
      rawConfigs.get(path),
      path,
      `${path}.config`,
      true,
      new Set(),
      true,
    );
    checkValue(sel.config, path, `${path}.config`, true, new Set(), true);
    try {
      const inputs = sel.existing ? {} : sel.infra.inputs(sel.config);
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
        fail(`${path}.infra.inputs`, "Expected an input record");
      else checkValue(inputs, path, `${path}.infra.inputs`, false);
    } catch (error) {
      fail(`${path}.infra.inputs`, String(error));
    }
    if (sel.existing) {
      for (const name of Object.keys(sel.infra.module.outputs))
        if (!Object.hasOwn(sel.existing, name))
          fail(`${path}.existing.${name}`, "Missing existing output");
      for (const [name, val] of Object.entries(sel.existing)) {
        if (!Object.hasOwn(sel.infra.module.outputs, name))
          fail(`${path}.existing.${name}`, "Unknown existing output");
        checkValue(val, path, `${path}.existing.${name}`, false);
        const expected = ownValue(sel.infra.module.outputs, name);
        if (expected && !existingTypeCompatible(val, expected, path))
          fail(`${path}.existing.${name}`, `Expected ${expected} output value`);
      }
    }
    for (const [i, binding] of sel.infra.bindings.entries()) {
      const loc = `${path}.infra.bindings.${i}`;
      if (!platform.bindingKinds.includes(binding.kind))
        fail(loc, `Platform does not support ${binding.kind} bindings`);
      if (
        platform.reservedBindings.some((pattern) =>
          pattern.endsWith("*")
            ? binding.name.startsWith(pattern.slice(0, -1))
            : binding.name === pattern,
        )
      )
        fail(loc, `Reserved binding name ${binding.name}`);
      if (binding.kind === "platform" && !binding.platformType)
        fail(loc, "Platform binding requires a type");
      if (binding.kind !== "platform" && binding.platformType)
        fail(loc, "Unexpected platform binding type");
      checkValue(binding.value, path, `${loc}.value`, true);
      if (binding.kind === "env") {
        const value = binding.value;
        const scalar =
          typeof value === "string" ||
          (isEnvRef(value) && value.valueType === undefined) ||
          (isVariableRef(value) &&
            ownValue(stack.variables, value.name)?.type === "string") ||
          (isStackRef(value) && value.name !== "tags") ||
          (isOutputRef(value) &&
            ownValue(
              all.get(value.selection ?? path)?.infra.module.outputs,
              value.name,
            ) === "string");
        if (!scalar) fail(loc, "Environment binding requires a scalar string");
      }
      if (binding.kind === "secret") {
        const value = binding.value;
        if (!isOutputRef(value) && !isVariableRef(value) && !isEnvRef(value))
          fail(loc, "Secret binding must be a reference");
        else if (isOutputRef(value)) {
          const target = value.selection ?? path;
          const outputType = ownValue(
            all.get(target)?.infra.module.outputs,
            value.name,
          );
          if (outputType && outputType !== "secret-ref")
            fail(loc, "Secret output must be declared as secret-ref");
        } else if (
          isVariableRef(value) &&
          !ownValue(stack.variables, value.name)?.sensitive
        )
          fail(loc, "Secret variable must be sensitive");
        else if (isEnvRef(value) && value.phase !== "runtime")
          fail(loc, "Secret environment reference must resolve at runtime");
      }
      for (const r of binding.roles) {
        roleExists(r, loc);
        const group = groups.findIndex((g) => g.roles.includes(r));
        const key = `${group}:${binding.name}`;
        const previous = names.get(key);
        if (previous && previous !== loc)
          fail(loc, `Duplicate binding ${binding.name} in function`);
        else names.set(key, loc);
      }
    }
    for (const [capability, policyOutput] of Object.entries(
      sel.infra.capabilities,
    )) {
      if (ownValue(sel.infra.module.outputs, policyOutput) !== "json")
        fail(
          `${path}.infra.capabilities.${capability}`,
          "Capability requires a declared JSON policy output",
        );
    }
    for (const [i, grant] of sel.infra.grants.entries()) {
      const loc = `${path}.infra.grants.${i}`;
      roleExists(grant.role, loc);
      if (!Object.hasOwn(sel.infra.capabilities, grant.capability))
        fail(loc, `Unknown capability ${grant.capability}`);
      for (const [field, v] of [
        ["resource", grant.resource],
        ["policy", grant.policy],
      ] as const) {
        if (!isOutputRef(v))
          fail(`${loc}.${field}`, "Grant requires an output reference");
        else {
          checkValue(v, path, `${loc}.${field}`, false);
          const target = v.selection ?? path;
          const type = all.get(target)?.infra.module.outputs[v.name];
          if (field === "policy" && target !== path)
            fail(`${loc}.policy`, "Policy must come from the granting adapter");
          if (
            field === "policy" &&
            sel.infra.capabilities[grant.capability] &&
            v.name !== sel.infra.capabilities[grant.capability]
          )
            fail(`${loc}.policy`, "Policy output does not match capability");
          if (field === "policy" && type && type !== "json")
            fail(`${loc}.policy`, "Policy output must be JSON");
          if (
            field === "resource" &&
            type &&
            type !== "string" &&
            type !== "string[]" &&
            type !== "secret-ref"
          )
            fail(
              `${loc}.resource`,
              "Resource output must be a string or string list",
            );
        }
      }
    }
  }
  const topics = stack.queue.infra.topics;
  if (!topics) fail("queue.infra.topics", "Queue must map core topics");
  else {
    const keys = Object.keys(topics.routes);
    for (const topic of TOPICS)
      if (!ownValue(topics.routes, topic))
        fail(`queue.infra.topics.${topic}`, "Missing topic route");
    for (const key of keys)
      if (!TOPICS.includes(key as CoreTopic))
        fail(`queue.infra.topics.${key}`, "Unknown topic");
    const physical: string[] = [];
    for (const [topic, route] of Object.entries(topics.routes)) {
      physical.push(route.physical);
      roleExists(route.consumer, `queue.infra.topics.${topic}.consumer`);
      for (const producer of route.producers)
        roleExists(producer, `queue.infra.topics.${topic}.producers`);
      if (!route.producers.length)
        fail(`queue.infra.topics.${topic}.producers`, "Missing producer");
      checkValue(
        route.resource,
        "queue",
        `queue.infra.topics.${topic}.resource`,
        false,
      );
      if (
        route.producerBinding &&
        !stack.queue.infra.bindings.some(
          (binding) => binding.name === route.producerBinding,
        )
      )
        fail(
          `queue.infra.topics.${topic}.producerBinding`,
          "Unknown producer binding",
        );
      if (platform.authorization !== "none") {
        const resource = route.resource;
        const isOutput = isOutputRef(resource);
        if (!isOutput)
          fail(
            `queue.infra.topics.${topic}.resource`,
            "Cloud topic requires a queue output reference",
          );
        const sameResource = (candidate: OutputRef) =>
          isOutput &&
          candidate.name === resource.name &&
          (candidate.selection ?? "queue") === (resource.selection ?? "queue");
        const binding = stack.queue.infra.bindings.find(
          (item) => item.name === route.producerBinding,
        );
        if (!route.producerBinding || !binding)
          fail(
            `queue.infra.topics.${topic}.producerBinding`,
            "Missing producer binding",
          );
        if (
          platform.authorization === "bindings" &&
          binding &&
          binding.kind !== "platform"
        )
          fail(
            `queue.infra.topics.${topic}.producerBinding`,
            "Binding authorization requires a platform binding",
          );
        for (const producer of route.producers) {
          if (binding && !binding.roles.includes(producer))
            fail(
              `queue.infra.topics.${topic}.producerBinding`,
              `Producer ${producer} lacks the binding`,
            );
          if (
            platform.authorization === "iam" &&
            !stack.queue.infra.grants.some(
              (grant) =>
                grant.role === producer &&
                grant.capability === "produce" &&
                sameResource(grant.resource),
            )
          )
            fail(
              `queue.infra.topics.${topic}.producers`,
              `Producer ${producer} lacks a resource grant`,
            );
        }
        if (
          platform.authorization === "iam" &&
          !stack.queue.infra.grants.some(
            (grant) =>
              grant.role === route.consumer &&
              grant.capability === "consume" &&
              sameResource(grant.resource),
          )
        )
          fail(
            `queue.infra.topics.${topic}.consumer`,
            "Consumer lacks a resource grant",
          );
      }
    }
    if (
      topics.mode === "shared" &&
      new Set(Object.values(topics.routes).map((route) => route.consumer))
        .size > 1
    )
      fail("queue.infra.topics", "A shared queue requires one consumer role");
    const resourceKey = (value: InfraValue): string => {
      if (isOutputRef(value))
        return JSON.stringify([value.selection ?? "queue", value.name]);
      return JSON.stringify(value);
    };
    if (
      topics.mode === "shared" &&
      new Set(
        Object.values(topics.routes).map((route) =>
          resourceKey(route.resource),
        ),
      ).size > 1
    )
      fail("queue.infra.topics", "A shared queue requires one resource");
    if (topics.mode === "shared" && new Set(physical).size > 1)
      fail(
        "queue.infra.topics",
        "Shared topics must use the same physical queue",
      );
    if (
      topics.mode === "per-topic" &&
      new Set(physical).size !== physical.length
    )
      fail("queue.infra.topics", "Per-topic queues must be distinct");
    if (
      topics.mode === "per-topic" &&
      new Set(
        Object.values(topics.routes).map((route) =>
          resourceKey(route.resource),
        ),
      ).size !== physical.length
    )
      fail("queue.infra.topics", "Per-topic queues require distinct resources");
  }
  for (const job of functions.cron) {
    const match = CRON_JOBS.find((j) => j.name === job);
    if (!match) fail("platform.config.cron", `Unknown cron job ${job}`);
    else roleExists(match.role, `platform.config.cron.${job}`);
  }
  if (new Set(functions.cron).size !== functions.cron.length)
    fail("platform.config.cron", "Duplicate cron job");
  if (
    stack.queue.manifest.capabilities.delivery === "pull" &&
    platform.compute === "function"
  )
    fail("queue", "Pull-only queues require long-lived compute");
  for (const [kind, required] of Object.entries(stack.requirements ?? {})) {
    const sel = all.get(kind);
    if (!sel && Object.keys(required).length === 0)
      fail(`${kind}.capabilities`, "Unknown selection");
    for (const [cap, expected] of Object.entries(required))
      if (!sel || ownValue(sel.manifest.capabilities, cap) !== expected)
        fail(`${kind}.capabilities.${cap}`, `Requires ${String(expected)}`);
  }
  function topological(
    edges: Map<string, Set<string>>,
    label: string,
  ): string[] {
    const order: string[] = [];
    const visited = new Set<string>(),
      active = new Set<string>();
    function visit(path: string) {
      if (active.has(path)) {
        fail(path, `${label} dependency cycle`);
        return;
      }
      if (visited.has(path)) return;
      active.add(path);
      for (const dep of [...(edges.get(path) ?? [])].sort()) visit(dep);
      active.delete(path);
      visited.add(path);
      order.push(path);
    }
    for (const path of all.keys()) visit(path);
    return order;
  }
  topological(moduleGraph, "Module");
  const order = topological(graph, "Runtime");
  return { issues, resolved: stack, order };
}
export function validateStack(stack: unknown): StackValidationIssue[] {
  if (
    typeof stack === "object" &&
    stack !== null &&
    resolvedOrders.has(stack as StackConfig)
  )
    return [];
  return inspect(stack).issues;
}
/** Validates and resolves configuration defaults without resolving Terraform or runtime references. */
export function resolveStack(stack: unknown): ResolvedStack {
  if (
    typeof stack === "object" &&
    stack !== null &&
    resolvedOrders.has(stack as StackConfig)
  )
    return stack as ResolvedStack;
  const result = inspect(stack);
  if (result.issues.length || !result.resolved)
    throw new Error(
      `Invalid stack: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  const snapshot = frozenSnapshot(result.resolved) as ResolvedStack;
  resolvedOrders.set(snapshot, result.order ?? []);
  return snapshot;
}
export function constructionOrder(stack: StackConfig): string[] {
  const cached = resolvedOrders.get(stack);
  if (cached) return [...cached];
  const result = inspect(stack);
  if (result.issues.length || !result.order)
    throw new Error(
      `Invalid stack: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  return result.order;
}
export function defineStack<T extends StackConfig>(
  stack: T,
): T & ResolvedStack {
  return resolveStack(stack) as T & ResolvedStack;
}

export type DerivedTrigger =
  | {
      kind: "queue";
      physical: string;
      role: FunctionRole;
      resource: InfraValue;
      topics: CoreTopic[];
    }
  | { kind: "cron"; name: string; schedule: string; role: FunctionRole };
/** Derive one queue trigger per physical queue and one named trigger per enabled cron job. */
export function deriveTriggers(input: StackConfig): DerivedTrigger[] {
  const stack = resolveStack(input);
  const mapping = stack.queue.infra.topics;
  if (!mapping) throw new Error("Missing queue mapping");
  const queues = new Map<string, Extract<DerivedTrigger, { kind: "queue" }>>();
  for (const topic of TOPICS) {
    const route = mapping.routes[topic];
    let trigger = queues.get(route.physical);
    if (!trigger) {
      trigger = {
        kind: "queue",
        physical: route.physical,
        role: route.consumer,
        resource: route.resource,
        topics: [],
      };
      queues.set(route.physical, trigger);
    }
    trigger.topics.push(topic);
  }
  const config = platformConfigSchema.parse(stack.platform.config);
  const cron = config.cron.map((name) => {
    const job = CRON_JOBS.find((item) => item.name === name);
    if (!job) throw new Error(`Unknown cron job ${name}`);
    return { kind: "cron" as const, ...job };
  });
  return [...queues.values(), ...cron];
}
