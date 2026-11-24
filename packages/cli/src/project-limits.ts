import {
  type ActiveStore,
  NotFoundError,
  type Project,
  type ProjectRateLimits,
  type StackConfig,
  validateProjectRateLimits,
} from "@moriyoshi/errtraq-core";

/** A flag value: a positive count, `none` to clear the override, or absent to leave it alone. */
export type LimitInput = number | "none" | undefined;
export interface ProjectLimitChange {
  issueEvents?: LimitInput;
  newIssues?: LimitInput;
}

export function parseLimit(flag: string, text: string | undefined): LimitInput {
  if (text === undefined || text === "none") return text;
  if (!/^[1-9]\d{0,9}$/.test(text))
    throw new Error(`${flag} must be a positive integer or "none"`);
  return Number(text);
}
/**
 * Reject limits that the stack cannot honour: a value above the stack's or a limit the stack
 * leaves disabled. Both record modes can resolve per-issue overrides: the grouped consumer is
 * granted project reads when a per-issue limit is enabled.
 */
export function assertProjectLimitsAllowed(
  stack: StackConfig,
  limits: ProjectRateLimits,
): void {
  validateProjectRateLimits(stack.rateRejection, limits);
}
/** Split flag input into the values to set (validated by the caller) and the fields to clear. */
export function limitsFromInput(change: ProjectLimitChange): {
  set: ProjectRateLimits;
  clear: (keyof ProjectRateLimits)[];
} {
  const set: ProjectRateLimits = {};
  const clear: (keyof ProjectRateLimits)[] = [];
  for (const key of ["issueEvents", "newIssues"] as const) {
    const value = change[key];
    if (value === "none") clear.push(key);
    else if (value !== undefined) set[key] = value;
  }
  return { set, clear };
}
/**
 * Set or clear a project's tighter rate limits. Omitted fields keep their stored value. Only
 * the values being set are validated against the stack; a stored value that no longer fits is
 * clamped at enforcement time and can be replaced here.
 */
export async function setProjectRateLimits(
  store: ActiveStore,
  stack: StackConfig,
  options: { orgSlug: string; projectSlug: string } & ProjectLimitChange,
): Promise<Project> {
  const { set, clear } = limitsFromInput(options);
  assertProjectLimitsAllowed(stack, set);
  const org = await store.projects.getOrgBySlug(options.orgSlug);
  if (!org)
    throw new NotFoundError(`Organization "${options.orgSlug}" does not exist`);
  const project = await store.projects.getProjectBySlug(
    org.id,
    options.projectSlug,
  );
  if (!project)
    throw new NotFoundError(`Project "${options.projectSlug}" does not exist`);
  if (!Object.keys(set).length && !clear.length) return project;
  const merged: ProjectRateLimits = { ...project.rateLimits, ...set };
  for (const key of clear) delete merged[key];
  const { rateLimits: _previous, ...rest } = project;
  const updated: Project = Object.keys(merged).length
    ? { ...rest, rateLimits: merged }
    : rest;
  await store.projects.put(updated);
  return updated;
}
export function formatProjectLimits(project: Project): string {
  const { issueEvents, newIssues } = project.rateLimits ?? {};
  return [
    `issue events per window: ${issueEvents ?? "stack limit"}`,
    `new issues per window: ${newIssues ?? "stack limit"}`,
  ].join("\n");
}
