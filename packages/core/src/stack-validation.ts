import {
  type AdapterSelection,
  type CoreTopic,
  CRON_JOBS,
  type EnvRef,
  type FunctionRole,
  type InfraValue,
  type OutputRef,
  type OutputType,
  type PlatformConfig,
  type StackConfig,
  type StackRef,
  type StackValidationIssue,
  TOPICS,
  type VariableRef,
} from "./stack-model.js";
import {
  platformConfigSchema,
  platformSchema,
  requiredCapabilities,
  rootSchema,
} from "./stack-schema.js";

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
/** Deterministic physical groups derived only from platform config. */
export function functionGroups(config: PlatformConfig): FunctionRole[][] {
  const groups = config.split.map((role) => [role]);
  const shared = config.roles.filter((role) => !config.split.includes(role));
  if (shared.length) groups.push(shared);
  return groups;
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
  if (stack.providers?.aws && !stack.region)
    fail("region", "Region is required for the AWS provider");
  const all = selections(stack);
  const graph = new Map<string, Set<string>>();
  const moduleGraph = new Map<string, Set<string>>();
  for (const path of all.keys()) {
    graph.set(path, new Set());
    moduleGraph.set(path, new Set());
  }
  for (const [path, sel] of all) {
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
      if (!schema.safeParse(sel.manifest.capabilities[cap]).success)
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
      !stack.providers?.[sel.infra.module.provider]
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
    const rec = value as Record<string, unknown>;
    if (
      "kind" in rec &&
      (!configMode ||
        ["output", "stack", "variable", "env"].includes(String(rec.kind)))
    ) {
      const keys = Object.keys(rec).sort().join(",");
      if (
        rec.kind === "output" &&
        (keys === "kind,name" || keys === "kind,name,selection") &&
        typeof rec.name === "string" &&
        rec.name &&
        (rec.selection === undefined || typeof rec.selection === "string")
      ) {
        const target = (rec.selection as string | undefined) ?? owner;
        const selected = all.get(target);
        if (!selected) fail(path, `Unknown selection ${target}`);
        else if (!Object.hasOwn(selected.infra.module.outputs, rec.name))
          fail(path, `Unknown output ${target}.${rec.name}`);
        else if (
          selected.existing &&
          !Object.hasOwn(selected.existing, rec.name)
        )
          fail(path, `Missing existing output ${target}.${rec.name}`);
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
        rec.kind === "stack" &&
        keys === "kind,name" &&
        ["name", "region", "tags"].includes(String(rec.name))
      ) {
        if (rec.name === "region" && !stack.region)
          fail(path, "Stack region is missing");
      } else if (
        rec.kind === "variable" &&
        keys === "kind,name" &&
        typeof rec.name === "string"
      ) {
        if (!stack.variables?.[rec.name])
          fail(path, `Unknown variable ${rec.name}`);
      } else if (
        rec.kind === "env" &&
        keys === "kind,name,phase" &&
        typeof rec.name === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(rec.name) &&
        ["runtime", "generate"].includes(String(rec.phase))
      ) {
        if (rec.phase === "runtime" && !allowRuntime)
          fail(
            path,
            "Runtime environment reference cannot resolve during generation",
          );
      } else fail(path, "Invalid reference");
    } else
      for (const [k, v] of Object.entries(rec))
        checkValue(v, owner, `${path}.${k}`, allowRuntime, seen, configMode);
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
      if ("kind" in value) {
        if (value.kind !== "env" || value.phase !== "generate")
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
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "kind" in value
    ) {
      const ref = value as OutputRef | EnvRef | VariableRef | StackRef;
      if (ref.kind === "output") {
        const actual = all.get(ref.selection ?? owner)?.infra.module.outputs[
          ref.name
        ];
        return !actual || actual === expected;
      }
      if (ref.kind === "stack")
        return ref.name === "tags"
          ? expected === "json"
          : expected === "string" || expected === "json";
      if (ref.kind === "env")
        return (
          expected === "string" ||
          expected === "json" ||
          expected === "secret-ref"
        );
      if (ref.kind === "variable") {
        const type = stack.variables?.[ref.name]?.type;
        return (
          !type ||
          (expected === "string" && type === "string") ||
          (expected === "string[]" && type === "string[]") ||
          (expected === "secret-ref" && type === "string") ||
          (expected === "json" && (type === "json" || type === "string"))
        );
      }
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
  const groups = functionGroups(functions);
  const names = new Map<string, string>();
  for (const [path, sel] of all) {
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
        const expected = sel.infra.module.outputs[name];
        if (expected && !existingTypeCompatible(val, expected, path))
          fail(`${path}.existing.${name}`, `Expected ${expected} output value`);
      }
    }
    for (const [i, binding] of sel.infra.bindings.entries()) {
      const loc = `${path}.infra.bindings.${i}`;
      if (binding.kind === "platform" && !binding.platformType)
        fail(loc, "Platform binding requires a type");
      if (binding.kind !== "platform" && binding.platformType)
        fail(loc, "Unexpected platform binding type");
      checkValue(binding.value, path, `${loc}.value`, true);
      if (binding.kind === "secret") {
        const value = binding.value;
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !("kind" in value) ||
          !["output", "variable", "env"].includes(String(value.kind))
        )
          fail(loc, "Secret binding must be a reference");
        else if (value.kind === "output" && typeof value.name === "string") {
          const target =
            typeof value.selection === "string" ? value.selection : path;
          const outputType = all.get(target)?.infra.module.outputs[value.name];
          if (outputType && outputType !== "secret-ref")
            fail(loc, "Secret output must be declared as secret-ref");
        } else if (
          value.kind === "variable" &&
          typeof value.name === "string" &&
          !stack.variables?.[value.name]?.sensitive
        )
          fail(loc, "Secret variable must be sensitive");
        else if (value.kind === "env" && value.phase !== "runtime")
          fail(loc, "Secret environment reference must resolve at runtime");
      }
      for (const r of binding.roles) {
        roleExists(r, loc);
        const group = groups.findIndex((g) => g.includes(r));
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
      if (sel.infra.module.outputs[policyOutput] !== "json")
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
        if (
          !v ||
          typeof v !== "object" ||
          Array.isArray(v) ||
          !("kind" in v) ||
          v.kind !== "output"
        )
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
      if (!topics.routes[topic])
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
      if (stack.queue.infra.module.provider !== "local") {
        const resource = route.resource;
        const isOutput =
          resource &&
          typeof resource === "object" &&
          !Array.isArray(resource) &&
          "kind" in resource &&
          resource.kind === "output";
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
        for (const producer of route.producers) {
          if (binding && !binding.roles.includes(producer))
            fail(
              `queue.infra.topics.${topic}.producerBinding`,
              `Producer ${producer} lacks the binding`,
            );
          if (
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
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "kind" in value &&
        value.kind === "output"
      )
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
      if (!sel || sel.manifest.capabilities[cap] !== expected)
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
  return inspect(stack).issues;
}
/** Validates and resolves configuration defaults without resolving Terraform or runtime references. */
export function resolveStack(stack: unknown): StackConfig {
  const result = inspect(stack);
  if (result.issues.length || !result.resolved)
    throw new Error(
      `Invalid stack: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  return result.resolved;
}
export function constructionOrder(stack: StackConfig): string[] {
  const result = inspect(stack);
  if (result.issues.length || !result.order)
    throw new Error(
      `Invalid stack: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  return result.order;
}
export function defineStack<T extends StackConfig>(stack: T): T {
  return resolveStack(stack) as T;
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
