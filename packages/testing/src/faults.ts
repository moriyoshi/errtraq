import type {
  ActiveStore,
  ArchiveStore,
  BlobStore,
  MetaRepo,
} from "@moriyoshi/errtraq-core";

/**
 * Fault injection for the archival crash matrix. A plan fires on the Nth call of a named operation,
 * either before the wrapped operation runs (it has no effect) or after it ran (it took effect but the
 * caller sees a failure), which is how a crash right before or right after a step looks to the worker.
 *
 * Operation names are `<scope>.<path>` where the scope is the wrapper's scope: `archive.append`,
 * `archive.hasBatch`, `events.deleteBatch`, `events.scanOlderThan`, `meta.compareAndSetArchiveState`,
 * `blob.put`, ...
 */
export interface FaultPlan {
  op: string;
  /** 1-based: the Nth call of op since the injector was created or last reset. */
  nth: number;
  when: "before" | "after";
}

export class InjectedFault extends Error {
  override name = "InjectedFault";
  constructor(readonly plan: FaultPlan) {
    super(`Injected fault ${plan.when} ${plan.op} call ${plan.nth}`);
  }
}

/** Shared by the wrappers of one scenario, so call counts are global per operation name. */
export class FaultInjector {
  private counts = new Map<string, number>();
  private plans: FaultPlan[] = [];
  /** Plans that fired, in order. */
  readonly fired: FaultPlan[] = [];

  /** Arm a plan. It fires once. */
  arm(plan: FaultPlan): this {
    if (!Number.isInteger(plan.nth) || plan.nth < 1)
      throw new RangeError("nth is 1-based");
    this.plans.push(plan);
    return this;
  }
  /** Drop pending plans; call counts continue. */
  disarm(): void {
    this.plans = [];
  }
  /** Drop pending plans and zero all call counts. */
  reset(): void {
    this.plans = [];
    this.counts.clear();
    this.fired.length = 0;
  }
  count(op: string): number {
    return this.counts.get(op) ?? 0;
  }
  /** Operation names seen so far with their call counts. */
  calls(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /** Called by wrappers. Returns the post-effect plan to throw, if one is due. */
  async run<T>(op: string, effect: () => Promise<T>): Promise<T> {
    const n = (this.counts.get(op) ?? 0) + 1;
    this.counts.set(op, n);
    const due = (when: FaultPlan["when"]) => {
      const index = this.plans.findIndex(
        (p) => p.op === op && p.nth === n && p.when === when,
      );
      if (index < 0) return null;
      const [plan] = this.plans.splice(index, 1);
      if (plan) this.fired.push(plan);
      return plan ?? null;
    };
    const before = due("before");
    if (before) throw new InjectedFault(before);
    const result = await effect();
    const after = due("after");
    if (after) throw new InjectedFault(after);
    return result;
  }
}

function wrap<T extends object>(
  target: T,
  faults: FaultInjector,
  scope: string,
  nested: readonly string[],
): T {
  return new Proxy(target, {
    get(inner, property) {
      const value = Reflect.get(inner, property, inner) as unknown;
      if (typeof property !== "string") return value;
      if (typeof value === "function")
        return (...args: unknown[]) =>
          faults.run(`${scope}.${property}`, async () =>
            Reflect.apply(value, inner, args),
          );
      if (nested.includes(property) && value && typeof value === "object")
        return wrap(value, faults, property, []);
      return value;
    },
  });
}

/** `archive.<method>` for append, hasBatch, query, getEvent, deleteWhere, hardErase, expireSnapshots. */
export function faultyArchiveStore(
  inner: ArchiveStore,
  faults: FaultInjector,
): ArchiveStore {
  return wrap(inner, faults, "archive", []);
}

/**
 * `<repo>.<method>` for events, issues, projects, releases and meta (for example
 * `events.deleteBatch`), and `recordEvent` / `recordEvents` on the store itself.
 */
export function faultyActiveStore(
  inner: ActiveStore,
  faults: FaultInjector,
): ActiveStore {
  return wrap(inner, faults, "active", [
    "projects",
    "issues",
    "events",
    "releases",
    "meta",
  ]);
}

/** `meta.<method>`: getArchiveState, compareAndSetArchiveState and the erasure ledger methods. */
export function faultyMeta(inner: MetaRepo, faults: FaultInjector): MetaRepo {
  return wrap(inner, faults, "meta", []);
}

/** `blob.<method>`: put, get, head, list, delete; for staging-object faults. */
export function faultyBlobStore(
  inner: BlobStore,
  faults: FaultInjector,
): BlobStore {
  return wrap(inner, faults, "blob", []);
}
