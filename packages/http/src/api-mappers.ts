import type { Issue, Org, Project, StoredEvent } from "@errtraq/core";

type Payload = Record<string, unknown>;
/** Map stored fields to the subset of Sentry's issue representation available locally. */
export function issueJson(
  issue: Issue,
  project: Project,
  org: Org,
  origin: string,
  payload: Payload = {},
) {
  return {
    id: issue.id,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    type: issue.type,
    metadata: issue.metadata,
    status: issue.status,
    statusDetails: {},
    count: String(issue.count),
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    project: { id: project.id, name: project.name, slug: project.slug },
    permalink: `${origin}/organizations/${encodeURIComponent(org.slug)}/issues/${issue.id}/`,
    platform: payload.platform ?? null,
    logger: payload.logger ?? null,
    isBookmarked: false,
    isPublic: false,
    hasSeen: false,
    numComments: 0,
    assignedTo: null,
    annotations: [],
    userCount: 0,
  }; // TODO(M5): count distinct users.
}
/** Map stored payload interfaces into Sentry event entries. */
export function eventJson(
  event: StoredEvent,
  issue: Issue,
  payload: Payload = event.payload,
) {
  const entries: Array<{ type: string; data: unknown }> = [];
  if (payload.exception)
    entries.push({ type: "exception", data: payload.exception });
  if (payload.logentry || payload.message)
    entries.push({
      type: "message",
      data: payload.logentry ?? {
        message: payload.message,
        formatted: payload.message,
      },
    });
  if (payload.breadcrumbs)
    entries.push({ type: "breadcrumbs", data: payload.breadcrumbs });
  if (payload.request) entries.push({ type: "request", data: payload.request });
  const user = event.user
    ? {
        id: event.user.id,
        email: event.user.email,
        username: event.user.username,
        ip_address: event.user.ipAddress,
      }
    : null;
  return {
    id: event.eventId,
    eventID: event.eventId,
    groupID: event.issueId,
    projectID: event.projectId,
    title: issue.title,
    message:
      payload.message ??
      (payload.logentry as Payload | undefined)?.formatted ??
      "",
    culprit: issue.culprit,
    metadata: issue.metadata,
    type: issue.type,
    platform: payload.platform ?? null,
    dateCreated: event.timestamp,
    dateReceived: event.receivedAt,
    entries,
    tags: Object.entries(event.tags).map(([key, value]) => ({ key, value })),
    user,
    release: event.release ?? null,
    environment: event.environment ?? null,
    ...("extra" in payload ? { extra: payload.extra } : {}),
    ...("context" in payload ? { context: payload.context } : {}),
    ...("contexts" in payload ? { contexts: payload.contexts } : {}),
    ...("sdk" in payload ? { sdk: payload.sdk } : {}),
  };
}
