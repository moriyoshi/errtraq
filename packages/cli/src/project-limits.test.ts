import type { OrgId, Project, ProjectId, StackConfig } from "@errtraq/core";
import { MemoryActiveStore } from "@errtraq/testing";
import { describe, expect, it } from "vitest";
import {
  assertProjectLimitsAllowed,
  formatProjectLimits,
  parseLimit,
  setProjectRateLimits,
} from "./project-limits.js";

const stackWith = (
  rateRejection: StackConfig["rateRejection"],
  recordMode: "direct" | "grouped" = "direct",
) => ({ rateRejection, recordMode }) as unknown as StackConfig;
const full = stackWith({
  issueRateLimit: { events: 10, windowSec: 60 },
  newIssueCap: { issues: 5, windowSec: 60 },
});
async function fixture() {
  const store = new MemoryActiveStore();
  const orgId = "org-1" as OrgId;
  await store.projects.putOrg({ id: orgId, slug: "acme", name: "Acme" });
  const project: Project = {
    id: "1" as ProjectId,
    orgId,
    slug: "web",
    name: "web",
    retentionDays: 30,
  };
  await store.projects.put(project);
  return { store, project };
}
const target = { orgSlug: "acme", projectSlug: "web" };

describe("project rate limit command", () => {
  it("parses flag values", () => {
    expect(parseLimit("--x", undefined)).toBeUndefined();
    expect(parseLimit("--x", "none")).toBe("none");
    expect(parseLimit("--x", "7")).toBe(7);
    for (const bad of ["0", "-1", "1.5", "abc", "", "01", "99999999999"])
      expect(() => parseLimit("--x", bad)).toThrow(/positive integer/);
  });
  it("sets, merges, keeps and clears overrides", async () => {
    const f = await fixture();
    expect(
      (await setProjectRateLimits(f.store, full, { ...target, issueEvents: 4 }))
        .rateLimits,
    ).toEqual({ issueEvents: 4 });
    const both = await setProjectRateLimits(f.store, full, {
      ...target,
      newIssues: 2,
    });
    expect(both.rateLimits).toEqual({ issueEvents: 4, newIssues: 2 });
    // No flags reports the stored value and does not write.
    expect(
      (await setProjectRateLimits(f.store, full, target)).rateLimits,
    ).toEqual(both.rateLimits);
    expect(formatProjectLimits(both)).toContain("issue events per window: 4");
    const one = await setProjectRateLimits(f.store, full, {
      ...target,
      issueEvents: "none",
    });
    expect(one.rateLimits).toEqual({ newIssues: 2 });
    const none = await setProjectRateLimits(f.store, full, {
      ...target,
      newIssues: "none",
    });
    expect(none.rateLimits).toBeUndefined();
    expect(
      (await f.store.projects.get(f.project.id))?.rateLimits,
    ).toBeUndefined();
    expect(formatProjectLimits(none)).toContain("stack limit");
    // Other project fields are untouched.
    expect((await f.store.projects.get(f.project.id))?.retentionDays).toBe(30);
  });
  it("rejects a limit above the stack's and writes nothing", async () => {
    const f = await fixture();
    await expect(
      setProjectRateLimits(f.store, full, { ...target, issueEvents: 11 }),
    ).rejects.toThrow(/exceeds the stack limit/);
    await expect(
      setProjectRateLimits(f.store, full, { ...target, newIssues: 6 }),
    ).rejects.toThrow(/exceeds the stack limit/);
    expect(
      (await f.store.projects.get(f.project.id))?.rateLimits,
    ).toBeUndefined();
    // The stack's own value is allowed: it is not higher.
    await setProjectRateLimits(f.store, full, { ...target, issueEvents: 10 });
  });
  it("rejects a limit the stack leaves disabled", async () => {
    const f = await fixture();
    const onlyIssue = stackWith({
      issueRateLimit: { events: 10, windowSec: 60 },
    });
    await expect(
      setProjectRateLimits(f.store, onlyIssue, { ...target, newIssues: 1 }),
    ).rejects.toThrow(/does not enable/);
    await expect(
      setProjectRateLimits(f.store, stackWith(undefined), {
        ...target,
        issueEvents: 1,
      }),
    ).rejects.toThrow(/does not enable/);
    // Clearing needs nothing from the stack.
    await setProjectRateLimits(f.store, stackWith(undefined), {
      ...target,
      issueEvents: "none",
    });
  });
  it("accepts a per-issue override under grouped recording", () => {
    const grouped = stackWith(
      {
        issueRateLimit: { events: 10, windowSec: 60 },
        newIssueCap: { issues: 5, windowSec: 60 },
      },
      "grouped",
    );
    expect(() =>
      assertProjectLimitsAllowed(grouped, { issueEvents: 1, newIssues: 1 }),
    ).not.toThrow();
    // The stack's own bounds still apply.
    expect(() =>
      assertProjectLimitsAllowed(grouped, { issueEvents: 11 }),
    ).toThrow(/exceeds/);
  });
  it("reports a missing organization or project", async () => {
    const f = await fixture();
    await expect(
      setProjectRateLimits(f.store, full, {
        orgSlug: "nope",
        projectSlug: "web",
        issueEvents: 1,
      }),
    ).rejects.toThrow(/Organization "nope" does not exist/);
    await expect(
      setProjectRateLimits(f.store, full, {
        orgSlug: "acme",
        projectSlug: "nope",
        issueEvents: 1,
      }),
    ).rejects.toThrow(/Project "nope" does not exist/);
  });
});
