function ownValue<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

import {
  type AdapterSelection,
  artifact,
  type CoreTopic,
  CRON_JOBS,
  type DeploymentTrigger,
  type DeploymentView,
  type DerivedGrant,
  FUNCTION_ROLES,
  type FunctionRole,
  type FunctionSettings,
  type InfraValue,
  isArtifactRef,
  isEnvRef,
  isInfraRef,
  isOutputRef,
  isStackRef,
  isVariableRef,
  type OutputType,
  output,
  type PhysicalFunction,
  type PlatformConfig,
  QUEUE_VISIBILITY_FACTOR,
  REF,
  type ScopedBinding,
  type SecretReadRequirement,
  type StackConfig,
  type StackValidationIssue,
  TOPICS,
} from "./stack-model.js";
import {
  PORT_REQUIREMENTS,
  QUEUE_CAPABILITIES,
  TOPIC_ROUTES,
} from "./stack-requirements.js";
import {
  platformConfigSchema,
  platformSchema,
  requiredCapabilities,
  rootSchema,
} from "./stack-schema.js";

function outputTypeAt(
  type: OutputType | undefined,
  path: readonly string[] = [],
): OutputType | undefined {
  for (const _key of path) {
    if (!type || typeof type !== "object") return undefined;
    type = type.map;
  }
  return type;
}

interface AccessRequirement {
  selection: string;
  role: FunctionRole;
  capability: string;
  purpose: string;
}
function accessRequirements(
  stack: StackConfig,
  roles: readonly FunctionRole[],
): AccessRequirement[] {
  const result: AccessRequirement[] = PORT_REQUIREMENTS.filter(
    (row) => roles.includes(row.role) && (!row.feature || stack[row.feature]),
  ).map((row) => ({
    selection: row.kind,
    role: row.role,
    capability: row.capability,
    purpose: row.purpose,
  }));
  const mapping = stack.queue.infra.topics;
  if (mapping)
    for (const topic of TOPICS) {
      const route = TOPIC_ROUTES[topic];
      if (route.feature && !stack[route.feature]) continue;
      const physical = mapping.routes[topic]?.physical;
      if (!physical) continue;
      for (const role of route.producers)
        if (roles.includes(role))
          result.push({
            selection: "queue",
            role,
            capability: QUEUE_CAPABILITIES.producer,
            purpose: physical,
          });
      if (roles.includes(route.consumer))
        result.push({
          selection: "queue",
          role: route.consumer,
          capability: QUEUE_CAPABILITIES.consumer,
          purpose: physical,
        });
    }
  return result;
}
function deriveAccessFor(
  stack: StackConfig,
  functions: PhysicalFunction[],
): {
  grants: DerivedGrant[];
  bindings: ScopedBinding[];
  secretReads: SecretReadRequirement[];
} {
  const all = selections(stack);
  const grants: DerivedGrant[] = [];
  const bindings: ScopedBinding[] = [];
  for (const fn of functions) {
    const rows = accessRequirements(stack, fn.roles);
    for (const row of rows) {
      const sel = all.get(row.selection);
      if (!sel) continue;
      if (
        !grants.some(
          (g) =>
            g.functionId === fn.id &&
            g.selection === row.selection &&
            g.capability === row.capability &&
            g.purpose === row.purpose,
        )
      ) {
        const policyOutput = ownValue(
          ownValue(sel.infra.capabilities, row.capability),
          row.purpose,
        );
        grants.push({
          functionId: fn.id,
          selection: row.selection,
          capability: row.capability,
          purpose: row.purpose,
          ...(policyOutput ? { policyOutput } : {}),
        });
      }
      for (const binding of sel.infra.bindings.filter(
        (b) =>
          b.purpose === row.purpose &&
          (!b.capabilities || b.capabilities.includes(row.capability)),
      ))
        if (
          !bindings.some(
            (b) =>
              b.functionId === fn.id &&
              b.selection === row.selection &&
              b.binding === binding,
          )
        )
          bindings.push({
            functionId: fn.id,
            selection: row.selection,
            binding,
          });
    }
  }
  return {
    grants,
    bindings,
    secretReads: bindings
      .filter((item) => item.binding.kind === "secret")
      .map((item) => ({
        functionId: item.functionId,
        selection: item.selection,
        bindingName: item.binding.name,
        identifier: item.binding.value,
      })),
  };
}
/** Derive the immutable inputs a platform needs, without re-running adapter schemas. */
function qualifyValue(value: InfraValue, owner: string): InfraValue {
  if (Array.isArray(value))
    return value.map((item) => qualifyValue(item, owner));
  if (!value || typeof value !== "object") return value;
  if (isOutputRef(value))
    return value.selection
      ? value
      : output(owner, value.name, ...(value.path ?? []));
  if (isInfraRef(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      qualifyValue(item, owner),
    ]),
  );
}
function deploymentFor(
  stack: StackConfig,
  functions: PhysicalFunction[],
  config: PlatformConfig,
): DeploymentView {
  const access = deriveAccessFor(stack, functions);
  const bindings = access.bindings.map((item) => ({
    ...item,
    binding: {
      ...item.binding,
      value: qualifyValue(item.binding.value, item.selection),
    },
  }));
  const view: DeploymentView = {
    functions: functions.map((fn) => ({
      ...fn,
      artifact: artifact(fn.id),
      http: (config.http ?? []).filter((role) => fn.roles.includes(role)),
      envBindings: bindings.filter(
        (item) => item.functionId === fn.id && item.binding.kind === "env",
      ),
      secretBindings: bindings.filter(
        (item) => item.functionId === fn.id && item.binding.kind === "secret",
      ),
      platformBindings: bindings.filter(
        (item) => item.functionId === fn.id && item.binding.kind === "platform",
      ),
      policies: access.grants
        .filter(
          (grant) =>
            grant.functionId === fn.id && grant.policyOutput !== undefined,
        )
        .map((grant) => ({
          ...grant,
          policyOutput:
            grant.policyOutput &&
            output(
              grant.selection,
              grant.policyOutput.name,
              ...(grant.policyOutput.path ?? []),
            ),
        })),
      secretReads: access.secretReads
        .filter((item) => item.functionId === fn.id)
        .map((item) => ({
          ...item,
          identifier: qualifyValue(item.identifier, item.selection),
        })),
    })),
    triggers: [],
  };
  const mapping = stack.queue.infra.topics;
  if (mapping) {
    const queues = new Map<
      string,
      Extract<DeploymentTrigger, { kind: "queue" }>
    >();
    for (const topic of TOPICS) {
      const contract = TOPIC_ROUTES[topic];
      if (contract.feature && !stack[contract.feature]) continue;
      const route = mapping.routes[topic];
      if (!route) continue;
      const fn = functions.find((item) =>
        item.roles.includes(contract.consumer),
      );
      if (!fn) continue;
      let trigger = queues.get(route.physical);
      if (!trigger) {
        const resource =
          ownValue(stack.queue.infra.resources, route.physical) ?? null;
        trigger = {
          kind: "queue",
          functionId: fn.id,
          physical: route.physical,
          resource: qualifyValue(resource, "queue"),
          topics: [],
          settings: ownValue(mapping.settings, route.physical) ?? {},
        };
        queues.set(route.physical, trigger);
      }
      trigger.topics.push(topic);
    }
    view.triggers.push(...queues.values());
  }
  if (stack.archive)
    for (const job of CRON_JOBS) {
      const fn = functions.find((item) => item.roles.includes(job.role));
      if (fn)
        view.triggers.push({
          kind: "cron",
          functionId: fn.id,
          name: job.name,
          schedule: job.schedule,
        });
    }
  return view;
}
export function deriveDeployment(input: StackConfig): DeploymentView {
  const stack = resolveStack(input);
  const config = platformConfigSchema.parse(stack.platform.config);
  return deploymentFor(stack, physicalFunctions(config), config);
}
/** Access derived from core requirements, grouped by the actual physical functions. */
export function deriveAccess(input: StackConfig): {
  grants: DerivedGrant[];
  bindings: ScopedBinding[];
  secretReads: SecretReadRequirement[];
} {
  const stack = resolveStack(input);
  return deriveAccessFor(
    stack,
    physicalFunctions(platformConfigSchema.parse(stack.platform.config)),
  );
}
/** Resolve scopes for only these roles (used by role-specific runtime entrypoints). */
export function bindingsForRoles(
  input: StackConfig,
  roles: readonly FunctionRole[],
): ScopedBinding[] {
  const stack = resolveStack(input);
  return deriveAccessFor(stack, [
    { id: "runtime", roles: [...roles], settings: {} },
  ]).bindings;
}

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
  if (new Set(functions.http ?? []).size !== (functions.http ?? []).length)
    fail("platform.config.http", "Duplicate HTTP role");
  for (const roleName of functions.http ?? []) {
    if (roleName !== "ingest" && roleName !== "api")
      fail("platform.config.http", `Role ${roleName} has no HTTP app`);
    if (!functions.roles.includes(roleName))
      fail("platform.config.http", `Platform does not deploy ${roleName}`);
  }
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
    reachable = true,
    seenOutputs = new Set<string>(),
    context: "input" | "existing" | "backend" | "other" = "other",
    sensitiveInput = false,
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
        checkValue(
          item,
          owner,
          `${path}.${i}`,
          allowRuntime,
          seen,
          configMode,
          reachable,
          seenOutputs,
          context,
          sensitiveInput,
        );
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
        keys.every((k) => ["name", "selection", "path"].includes(k)) &&
        typeof value.name === "string" &&
        value.name &&
        (value.selection === undefined ||
          typeof value.selection === "string") &&
        (value.path === undefined ||
          (Array.isArray(value.path) &&
            value.path.length > 0 &&
            value.path.every(
              (key) =>
                typeof key === "string" &&
                /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key),
            )))
      ) {
        const target = value.selection ?? owner;
        const selected = all.get(target);
        if (!selected) fail(path, `Unknown selection ${target}`);
        else if (!Object.hasOwn(selected.infra.module.outputs, value.name))
          fail(path, `Unknown output ${target}.${value.name}`);
        else if (
          !outputTypeAt(
            ownValue(selected.infra.module.outputs, value.name),
            value.path,
          )
        )
          fail(path, `Invalid key path in output ${target}.${value.name}`);
        else if (reachable && selected.existing) {
          const label = [target, value.name, ...(value.path ?? [])].join(".");
          if (seenOutputs.has(label)) {
            fail(path, `Existing output cycle at ${label}`);
            seen.delete(value);
            return;
          }
          seenOutputs.add(label);
          let replacement: unknown = ownValue(selected.existing, value.name);
          if (replacement === undefined)
            fail(path, `Missing existing output ${label} needed by ${path}`);
          else if (isOutputRef(replacement))
            checkValue(
              output(
                replacement.selection ?? target,
                replacement.name,
                ...(replacement.path ?? []),
                ...(value.path ?? []),
              ),
              target,
              `${path} -> ${label}`,
              false,
              seen,
              false,
              true,
              seenOutputs,
              "existing",
              false,
            );
          else {
            for (const key of value.path ?? []) {
              if (
                !replacement ||
                typeof replacement !== "object" ||
                Array.isArray(replacement) ||
                REF in replacement ||
                !Object.hasOwn(replacement, key)
              ) {
                fail(
                  path,
                  `Missing existing output key ${label} needed by ${path}`,
                );
                replacement = undefined;
                break;
              }
              replacement = Object.getOwnPropertyDescriptor(
                replacement,
                key,
              )?.value;
            }
            if (replacement !== undefined)
              checkValue(
                replacement,
                target,
                `${path} -> ${label}`,
                false,
                seen,
                false,
                true,
                seenOutputs,
                "existing",
                false,
              );
          }
          seenOutputs.delete(label);
        }
        if (
          target !== owner &&
          selected &&
          (context === "input" || context === "existing")
        )
          moduleGraph.get(owner)?.add(target);
        if (target === owner && context === "existing")
          fail(path, "Existing value cannot refer to its own output");
        if (target === owner && context === "input")
          fail(path, "Module input cannot reference its own output");
      } else if (
        isArtifactRef(value) &&
        keys.length === 1 &&
        keys[0] === "functionId" &&
        typeof value.functionId === "string"
      ) {
        if (context !== "input" || owner !== "platform")
          fail(
            path,
            "Artifact references are only valid in platform module inputs",
          );
        else if (!groups.some((fn) => fn.id === value.functionId))
          fail(path, `Unknown artifact function ${value.functionId}`);
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
        const declaration = ownValue(stack.variables, value.name);
        if (!declaration) fail(path, `Unknown variable ${value.name}`);
        else if (
          declaration.sensitive &&
          !(context === "input" && sensitiveInput)
        )
          fail(
            path,
            "Sensitive variables require a declared sensitive module input",
          );
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
        if (value.phase === "generate" && context !== "backend")
          fail(
            path,
            "Generation environment references are only allowed in backend config or stack metadata",
          );
        if (value.phase === "runtime" && !allowRuntime)
          fail(
            path,
            "Runtime environment reference cannot resolve during generation",
          );
      } else fail(path, "Invalid reference");
    } else {
      for (const [k, v] of Object.entries(value))
        checkValue(
          v,
          owner,
          `${path}.${k}`,
          allowRuntime,
          seen,
          configMode,
          reachable,
          seenOutputs,
          context,
          sensitiveInput,
        );
    }
    seen.delete(value);
  };
  if (stack.backend) {
    checkValue(
      stack.backend.config,
      "platform",
      "backend.config",
      false,
      new Set(),
      false,
      true,
      new Set(),
      "backend",
    );
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
      const actual = outputTypeAt(
        ownValue(
          all.get(value.selection ?? owner)?.infra.module.outputs,
          value.name,
        ),
        value.path,
      );
      return !actual || JSON.stringify(actual) === JSON.stringify(expected);
    }
    if (typeof expected === "object") {
      if (isVariableRef(value))
        return ownValue(stack.variables, value.name)?.type === "json";
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        isInfraRef(value)
      )
        return false;
      return Object.values(value).every((item) =>
        existingTypeCompatible(item, expected.map, owner),
      );
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
  // Descriptors cannot alter the data that validation subsequently relies on.
  const deployment = frozenSnapshot(deploymentFor(stack, groups, functions));
  for (const [name, ref] of Object.entries(stack.outputs ?? {}))
    checkValue(ref, "platform", `outputs.${name}`, false);
  for (const key of Object.keys(stack.queue.infra.topics?.settings ?? {}))
    if (
      !Object.values(stack.queue.infra.topics?.routes ?? {}).some(
        (route) => route.physical === key,
      )
    )
      fail(`queue.infra.topics.settings.${key}`, "Unknown physical queue");
  for (const trigger of deployment.triggers) {
    if (trigger.kind !== "queue") continue;
    const setting = trigger.settings;
    if (setting.dlq?.enabled && !stack.queue.manifest.capabilities.dlq)
      fail(
        `queue.infra.topics.settings.${trigger.physical}.dlq`,
        "Queue does not support a DLQ",
      );
    if (
      setting.dlq?.enabled === false &&
      setting.dlq.maxReceiveCount !== undefined
    )
      fail(
        `queue.infra.topics.settings.${trigger.physical}.dlq`,
        "Disabled DLQ cannot specify maxReceiveCount",
      );
    const timeout = deployment.functions.find(
      (fn) => fn.id === trigger.functionId,
    )?.settings.timeoutSec;
    if (timeout !== undefined && setting.visibilityTimeoutSec === undefined)
      fail(
        `queue.infra.topics.settings.${trigger.physical}.visibilityTimeoutSec`,
        "Queue visibility is required when the consumer timeout is configured",
      );
    if (setting.visibilityTimeoutSec !== undefined) {
      if (timeout === undefined)
        fail(
          `queue.infra.topics.settings.${trigger.physical}.visibilityTimeoutSec`,
          "Consumer timeout is required to validate queue visibility",
        );
      else if (setting.visibilityTimeoutSec < timeout * QUEUE_VISIBILITY_FACTOR)
        fail(
          `queue.infra.topics.settings.${trigger.physical}.visibilityTimeoutSec`,
          "Visibility timeout must be at least six times the consumer timeout",
        );
    }
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
      const inputs = sel.existing
        ? {}
        : sel.infra.inputs(sel.config, deployment);
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
        fail(`${path}.infra.inputs`, "Expected an input record");
      else
        for (const [key, value] of Object.entries(inputs))
          checkValue(
            value,
            path,
            `${path}.infra.inputs.${key}`,
            false,
            new Set(),
            false,
            true,
            new Set(),
            "input",
            sel.infra.module.sensitiveInputs?.includes(key) ?? false,
          );
    } catch (error) {
      fail(`${path}.infra.inputs`, String(error));
    }
    if (sel.existing) {
      for (const [name, val] of Object.entries(sel.existing)) {
        if (!Object.hasOwn(sel.infra.module.outputs, name))
          fail(`${path}.existing.${name}`, "Unknown existing output");
        checkValue(
          val,
          path,
          `${path}.existing.${name}`,
          false,
          new Set(),
          false,
          false,
          new Set(),
          "existing",
        );
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
      checkValue(
        binding.value,
        path,
        `${loc}.value`,
        true,
        new Set(),
        false,
        false,
      );
      if (binding.kind === "env") {
        const value = binding.value;
        const scalar =
          typeof value === "string" ||
          (isEnvRef(value) && value.valueType === undefined) ||
          (isVariableRef(value) &&
            ownValue(stack.variables, value.name)?.type === "string") ||
          (isStackRef(value) && value.name !== "tags") ||
          (isOutputRef(value) &&
            outputTypeAt(
              ownValue(
                all.get(value.selection ?? path)?.infra.module.outputs,
                value.name,
              ),
              value.path,
            ) === "string");
        if (!scalar) fail(loc, "Environment binding requires a scalar string");
      }
      if (binding.kind === "secret") {
        const value = binding.value;
        if (!isOutputRef(value) && !isVariableRef(value))
          fail(loc, "Secret binding must reference a secret-store identifier");
        else if (isOutputRef(value)) {
          const target = value.selection ?? path;
          const outputType = outputTypeAt(
            ownValue(all.get(target)?.infra.module.outputs, value.name),
            value.path,
          );
          if (outputType && outputType !== "secret-ref")
            fail(loc, "Secret output must be declared as secret-ref");
        } else if (
          isVariableRef(value) &&
          (ownValue(stack.variables, value.name)?.type !== "string" ||
            ownValue(stack.variables, value.name)?.sensitive)
        )
          fail(
            loc,
            "Secret identifier variable must be a non-sensitive string",
          );
      }
      if (!Object.hasOwn(sel.infra.resources, binding.purpose))
        fail(loc, `Unknown binding purpose ${binding.purpose}`);
      for (const capability of binding.capabilities ?? [])
        if (!Object.hasOwn(sel.infra.capabilities, capability))
          fail(loc, `Unknown binding capability ${capability}`);
    }
    for (const [purpose, resource] of Object.entries(sel.infra.resources))
      checkValue(
        resource,
        path,
        `${path}.infra.resources.${purpose}`,
        false,
        new Set(),
        false,
        false,
      );
    for (const [capability, policies] of Object.entries(
      sel.infra.capabilities,
    )) {
      for (const [purpose, policy] of Object.entries(policies)) {
        const loc = `${path}.infra.capabilities.${capability}.${purpose}`;
        if (!Object.hasOwn(sel.infra.resources, purpose))
          fail(loc, "Unknown policy resource purpose");
        if (policy) {
          checkValue(policy, path, loc, false, new Set(), false, false);
          if (
            (policy.selection ?? path) !== path ||
            outputTypeAt(
              ownValue(sel.infra.module.outputs, policy.name),
              policy.path,
            ) !== "json"
          )
            fail(
              loc,
              "Capability requires a declared JSON policy output from its own module",
            );
        }
      }
    }
  }
  for (const row of accessRequirements(stack, functions.roles)) {
    const sel = all.get(row.selection);
    if (!sel) continue;
    const loc = `${row.selection}.infra`;
    if (!Object.hasOwn(sel.infra.capabilities, row.capability))
      fail(
        `${loc}.capabilities`,
        `Role ${row.role} requires ${row.selection} capability ${row.capability}`,
      );
    else if (
      !Object.hasOwn(
        ownValue(sel.infra.capabilities, row.capability) ?? {},
        row.purpose,
      )
    )
      fail(
        `${loc}.capabilities`,
        `Role ${row.role} requires ${row.selection} capability ${row.capability} for ${row.purpose}`,
      );
    else if (
      platform.authorization === "iam" &&
      ownValue(
        ownValue(sel.infra.capabilities, row.capability),
        row.purpose,
      ) === null
    )
      fail(
        `${loc}.capabilities`,
        `Role ${row.role} requires ${row.selection} capability ${row.capability} with an IAM policy`,
      );
    if (!Object.hasOwn(sel.infra.resources, row.purpose))
      fail(
        `${loc}.resources`,
        `Role ${row.role} requires ${row.selection} resource ${row.purpose}`,
      );
    const resource = ownValue(sel.infra.resources, row.purpose);
    if (resource !== undefined)
      checkValue(
        resource,
        row.selection,
        `${loc}.resources.${row.purpose} (role ${row.role})`,
        false,
      );
    const policy = ownValue(
      ownValue(sel.infra.capabilities, row.capability),
      row.purpose,
    );
    if (platform.authorization === "iam" && policy)
      checkValue(
        policy,
        row.selection,
        `${loc}.capabilities.${row.capability}.${row.purpose} (role ${row.role})`,
        false,
      );
  }
  for (const scoped of deriveAccessFor(stack, groups).bindings) {
    checkValue(
      scoped.binding.value,
      scoped.selection,
      `${scoped.selection}.infra.bindings.${scoped.binding.name} (function ${scoped.functionId})`,
      true,
    );
    const key = `${scoped.functionId}:${scoped.binding.name}`;
    const previous = names.get(key);
    const loc = `${scoped.selection}.infra.bindings`;
    if (previous)
      fail(loc, `Duplicate binding ${scoped.binding.name} in function`);
    else names.set(key, loc);
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
      const contract = ownValue(TOPIC_ROUTES, topic);
      if (contract && (!contract.feature || stack[contract.feature])) {
        roleExists(contract.consumer, `queue.infra.topics.${topic}.consumer`);
        for (const producer of contract.producers)
          roleExists(producer, `queue.infra.topics.${topic}.producer`);
      }
      if (!Object.hasOwn(stack.queue.infra.resources, route.physical))
        fail(
          `queue.infra.topics.${topic}`,
          `Unknown queue resource ${route.physical}`,
        );
      else if (
        platform.authorization !== "none" &&
        !isOutputRef(ownValue(stack.queue.infra.resources, route.physical))
      )
        fail(
          `queue.infra.topics.${topic}`,
          "Queue resource requires an output reference",
        );
      const binding = stack.queue.infra.bindings.find(
        (item) => item.name === route.producerBinding,
      );
      if (
        platform.authorization !== "none" &&
        contract &&
        (!contract.feature || stack[contract.feature]) &&
        !binding
      )
        fail(
          `queue.infra.topics.${topic}.producerBinding`,
          "Missing producer binding",
        );
      if (
        route.producerBinding &&
        (!binding || binding.purpose !== route.physical)
      )
        fail(
          `queue.infra.topics.${topic}.producerBinding`,
          "Unknown producer binding for queue resource",
        );
      if (
        binding?.capabilities &&
        !binding.capabilities.includes(QUEUE_CAPABILITIES.producer)
      )
        fail(
          `queue.infra.topics.${topic}.producerBinding`,
          "Producer binding does not support the producer capability",
        );
      if (
        platform.authorization === "bindings" &&
        contract &&
        (!contract.feature || stack[contract.feature]) &&
        binding?.kind !== "platform"
      )
        fail(
          `queue.infra.topics.${topic}.producerBinding`,
          "Binding authorization requires a platform binding",
        );
    }
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
  }
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
  // The platform consumes these derived values and is built after all adapters.
  const access = deriveAccessFor(stack, groups);
  for (const item of [...access.grants, ...access.bindings])
    if (item.selection !== "platform")
      moduleGraph.get("platform")?.add(item.selection);
  if (topics) moduleGraph.get("platform")?.add("queue");
  for (const path of all.keys())
    if (path !== "platform") graph.get("platform")?.add(path);
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
      functionId: string;
      physical: string;
      role: FunctionRole;
      resource: InfraValue;
      topics: CoreTopic[];
      settings: import("./stack-model.js").QueueTriggerSettings;
    }
  | {
      kind: "cron";
      functionId: string;
      name: string;
      schedule: string;
      role: FunctionRole;
    };
/** Queue and cron triggers share the same derivation as the platform deployment view. */
export function deriveTriggers(input: StackConfig): DerivedTrigger[] {
  const view = deriveDeployment(input);
  return view.triggers.map((trigger) => {
    if (trigger.kind === "queue") {
      const first = trigger.topics[0];
      if (!first) throw new Error("Queue trigger has no topics");
      return { ...trigger, role: TOPIC_ROUTES[first].consumer };
    }
    const job = CRON_JOBS.find((item) => item.name === trigger.name);
    if (!job) throw new Error(`Unknown cron job ${trigger.name}`);
    return { ...trigger, role: job.role };
  });
}
