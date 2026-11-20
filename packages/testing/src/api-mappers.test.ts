import { readFile } from "node:fs/promises";
import {
  type EventId,
  type Issue,
  type IssueId,
  type Org,
  type OrgId,
  type Project,
  type ProjectId,
  type StoredEvent,
  toTimestamp,
} from "@errtraq/core";
import { describe, expect, it } from "vitest";
import { eventJson, issueJson } from "../../http/src/api-mappers.js";

const when = toTimestamp(new Date("2024-01-01T00:00:00.000Z"));
const project: Project = {
  id: "1" as ProjectId,
  orgId: "org" as OrgId,
  name: "Project",
  slug: "project",
  retentionDays: 30,
};
const org: Org = { id: project.orgId, slug: "org", name: "Org" };
const issue: Issue = {
  id: "issue" as IssueId,
  projectId: project.id,
  fingerprint: "fp",
  title: "TypeError: sample",
  culprit: "app.js",
  level: "error",
  type: "TypeError",
  metadata: {},
  status: "unresolved",
  firstSeen: when,
  lastSeen: when,
  count: 1,
  lastEventId: "event" as EventId,
  lastEventReceivedAt: when,
};
const event: StoredEvent = {
  projectId: project.id,
  issueId: issue.id,
  eventId: issue.lastEventId,
  timestamp: when,
  receivedAt: when,
  level: "error",
  tags: { region: "test" },
  user: {
    id: "1",
    email: "sample@example.invalid",
    username: "sample",
    ipAddress: "192.0.2.1",
  },
  release: "v1",
  environment: "test",
  payload: {
    message: "sample message",
    exception: { values: [] },
    breadcrumbs: { values: [] },
    request: { url: "https://example.invalid/" },
    platform: "javascript",
    contexts: {},
    sdk: { name: "sdk" },
  },
};
describe("Sentry response mappers", () => {
  it("matches documented issue and event sample shapes", async () => {
    const issueSample = JSON.parse(
      await readFile(
        new URL("../fixtures/sentry-api/issue.json", import.meta.url),
        "utf8",
      ),
    );
    const eventSample = JSON.parse(
      await readFile(
        new URL("../fixtures/sentry-api/event.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      issueJson(issue, project, org, "https://example.invalid", event.payload),
    ).toEqual(issueSample);
    expect(eventJson(event, issue)).toEqual(eventSample);
  });
});
