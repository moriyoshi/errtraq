import type {
  Issue,
  Org,
  Project,
  ProjectKey,
  StoredEvent,
} from "@moriyoshi/errtraq-core";

type Payload = Record<string, unknown>;
/** Sentry's organization summary. */
export function orgJson(org: Org) {
  return { id: org.id, slug: org.slug, name: org.name };
}
/** Sentry's project shape with errtraq's retention and rate limits under `errtraq`. */
export function projectJson(project: Project, org: Org) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    organization: orgJson(org),
    errtraq: {
      retentionDays: project.retentionDays,
      ...(project.rateLimits ? { rateLimits: project.rateLimits } : {}),
    },
  };
}
/**
 * A DSN key without its secret. `ingestUrl` is the public ingest origin; without it no `dsn` is
 * emitted because API and ingest can live on different hosts. The domain key has no name or
 * creation time, so `dateCreated` is omitted.
 */
export function keyJson(key: ProjectKey, ingestUrl?: string) {
  const dsn = ingestUrl && dsnOf(ingestUrl, key);
  return {
    id: key.id,
    name: "Default",
    public: key.publicKey,
    isActive: !key.revokedAt,
    ...(dsn ? { dsn: { public: dsn } } : {}),
  };
}
function dsnOf(ingestUrl: string, key: ProjectKey): string {
  const url = new URL(ingestUrl);
  url.username = key.publicKey;
  url.password = "";
  url.search = "";
  url.hash = "";
  // A path prefix on the ingest URL stays in front of the project ID, as Sentry DSNs allow.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${key.projectId}`;
  return url.toString();
}
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
