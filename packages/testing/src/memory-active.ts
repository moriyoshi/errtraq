import {
  type ActiveStore,
  type ApiToken,
  type ArchiveState,
  type ArtifactBundle,
  type Clock,
  type ErasureRequest,
  type Issue,
  NotFoundError,
  type Org,
  type Project,
  type ProjectKey,
  type Release,
  type StoredEvent,
  UnsupportedQueryError,
  VersionConflictError,
} from "@errtraq/core";
import { copy, eventOrder, eventPage, matchesSubject, page } from "./shared.js";

export class MemoryActiveStore implements ActiveStore {
  readonly capabilities = {
    lastSeenRangeOnOtherSort: false,
    textSearch: false,
  };
  private orgs = new Map<string, Org>();
  private projectRows = new Map<string, Project>();
  private keys = new Map<string, ProjectKey>();
  private tokens = new Map<string, ApiToken>();
  private issueRows = new Map<string, Issue>();
  private eventRows = new Map<string, StoredEvent>();
  private releaseRows = new Map<string, Release>();
  private bundles = new Map<string, ArtifactBundle>();
  private states = new Map<string, ArchiveState>();
  private erasures = new Map<string, ErasureRequest>();
  private key(...parts: string[]) {
    return JSON.stringify(parts);
  }
  constructor(
    private readonly ttlClock?: Clock,
    deleteStrategy: "explicit" | "ttl" = "explicit",
  ) {
    if (deleteStrategy === "ttl" && !ttlClock)
      throw new Error("TTL store needs a clock");
    this.events.capabilities.deleteStrategy = deleteStrategy;
  }
  private purgeExpired(): void {
    if (this.events.capabilities.deleteStrategy !== "ttl" || !this.ttlClock)
      return;
    for (const [key, event] of this.eventRows)
      if (event.expiresAt && event.expiresAt <= this.ttlClock.now())
        this.eventRows.delete(key);
  }
  async migrate(): Promise<void> {}
  projects: ActiveStore["projects"] = {
    getOrg: async (id) => copy(this.orgs.get(id) ?? null),
    getOrgBySlug: async (slug) =>
      copy([...this.orgs.values()].find((o) => o.slug === slug) ?? null),
    putOrg: async (org) => {
      this.orgs.set(org.id, copy(org));
    },
    get: async (id) => copy(this.projectRows.get(id) ?? null),
    getProjectBySlug: async (orgId, slug) =>
      copy(
        [...this.projectRows.values()].find(
          (p) => p.orgId === orgId && p.slug === slug,
        ) ?? null,
      ),
    put: async (project) => {
      this.projectRows.set(project.id, copy(project));
    },
    list: async (cursor, limit) =>
      page(
        [...this.projectRows.values()].sort((a, b) => a.id.localeCompare(b.id)),
        cursor,
        limit,
      ),
    getKey: async (key) => copy(this.keys.get(key) ?? null),
    putKey: async (key) => {
      this.keys.set(key.publicKey, copy(key));
    },
    listKeys: async (projectId) =>
      copy(
        [...this.keys.values()].filter((key) => key.projectId === projectId),
      ),
    getTokenByHash: async (hash) => copy(this.tokens.get(hash) ?? null),
    putToken: async (token) => {
      this.tokens.set(token.tokenHash, copy(token));
    },
  };
  recordEvent: ActiveStore["recordEvent"] = async (occurrence, event) => {
    this.purgeExpired();
    if (
      occurrence.projectId !== event.projectId ||
      occurrence.eventId !== event.eventId ||
      occurrence.issueId !== event.issueId ||
      occurrence.receivedAt !== event.receivedAt
    )
      throw new Error("Occurrence and event mismatch");
    const eventKey = this.key(event.projectId, event.eventId);
    const existing = this.eventRows.get(eventKey);
    if (existing) {
      const issue = [...this.issueRows.values()].find(
        (row) =>
          row.projectId === existing.projectId && row.id === existing.issueId,
      );
      if (!issue) throw new Error("Stored event has no issue");
      return {
        inserted: false,
        issue: copy(issue),
        isNew: false,
        isRegression: false,
      };
    }
    const eventCopy = copy(event);
    const key = this.key(occurrence.projectId, occurrence.fingerprint);
    const previous = this.issueRows.get(key);
    if (previous && previous.id !== occurrence.issueId)
      throw new Error("Issue ID does not match fingerprint");
    let issue = previous ? copy(previous) : undefined;
    const isNew = !issue;
    const isRegression =
      issue?.status === "resolved" &&
      (!issue.resolvedAt || occurrence.receivedAt > issue.resolvedAt);
    if (!issue) {
      issue = {
        id: occurrence.issueId,
        projectId: occurrence.projectId,
        fingerprint: occurrence.fingerprint,
        status: "unresolved",
        title: occurrence.title,
        culprit: occurrence.culprit,
        level: occurrence.level,
        type: occurrence.type,
        metadata: copy(occurrence.metadata),
        firstSeen: occurrence.receivedAt,
        lastSeen: occurrence.receivedAt,
        count: 0,
        lastEventId: occurrence.eventId,
        lastEventReceivedAt: occurrence.receivedAt,
      };
    }
    issue.count++;
    if (occurrence.receivedAt < issue.firstSeen)
      issue.firstSeen = occurrence.receivedAt;
    if (
      occurrence.receivedAt > issue.lastSeen ||
      (occurrence.receivedAt === issue.lastSeen &&
        occurrence.eventId > issue.lastEventId)
    ) {
      issue.lastSeen = occurrence.receivedAt;
      issue.lastEventReceivedAt = occurrence.receivedAt;
      issue.lastEventId = occurrence.eventId;
    }
    if (isRegression) {
      issue.status = "unresolved";
      delete issue.resolvedAt;
    }
    this.issueRows.set(key, issue);
    this.eventRows.set(eventKey, eventCopy);
    return {
      inserted: true,
      issue: copy(issue),
      isNew,
      isRegression: !!isRegression,
    };
  };

  issues: ActiveStore["issues"] = {
    get: async (projectId, id) =>
      copy(
        [...this.issueRows.values()].find(
          (i) => i.projectId === projectId && i.id === id,
        ) ?? null,
      ),
    list: async (query) => {
      if (query.text || ((query.from || query.to) && query.sort !== "lastSeen"))
        throw new UnsupportedQueryError("Unsupported filter");
      const rows = [...this.issueRows.values()].filter(
        (i) =>
          i.projectId === query.projectId &&
          (!query.status || i.status === query.status) &&
          (!query.from || i.lastSeen >= query.from) &&
          (!query.to || i.lastSeen < query.to),
      );
      rows.sort((a, b) => {
        const av = a[query.sort],
          bv = b[query.sort];
        return av < bv ? 1 : av > bv ? -1 : a.id.localeCompare(b.id);
      });
      return page(rows, query.cursor, query.limit);
    },
    repairAfterErasure: async (projectId, id, removedCount) => {
      const issue = [...this.issueRows.values()].find(
        (i) => i.projectId === projectId && i.id === id,
      );
      if (!issue) throw new NotFoundError("Issue not found");
      issue.count = Math.max(0, issue.count - removedCount);
      const latest = [...this.eventRows.values()]
        .filter((e) => e.projectId === projectId && e.issueId === id)
        .sort(eventOrder)
        .at(-1);
      if (latest) {
        issue.lastEventId = latest.eventId;
        issue.lastEventReceivedAt = latest.receivedAt;
      }
      return copy(issue);
    },
    update: async (projectId, id, patch) => {
      const issue = [...this.issueRows.values()].find(
        (i) => i.projectId === projectId && i.id === id,
      );
      if (!issue) throw new NotFoundError("Issue not found");
      Object.assign(issue, copy(patch));
      return copy(issue);
    },
  };
  events: ActiveStore["events"] = {
    capabilities: { deleteStrategy: "explicit" },
    get: async (projectId, eventId) => {
      this.purgeExpired();
      return copy(this.eventRows.get(this.key(projectId, eventId)) ?? null);
    },
    listByIssue: async (query) => {
      this.purgeExpired();
      return eventPage(
        [...this.eventRows.values()].filter(
          (e) =>
            e.projectId === query.projectId &&
            (!query.issueId || e.issueId === query.issueId) &&
            (!query.from || e.receivedAt >= query.from) &&
            (!query.to || e.receivedAt < query.to),
        ),
        query,
      );
    },
    scanOlderThan: async (projectId, cutoff, options) => {
      this.purgeExpired();
      const all = [...this.eventRows.values()]
        .filter((e) => e.projectId === projectId && e.receivedAt < cutoff)
        .sort(eventOrder);
      return page(all, options?.cursor, options?.limit);
    },
    deleteBatch: async (projectId, ids) => {
      for (const id of ids) this.eventRows.delete(this.key(projectId, id));
    },
    deleteBySubject: async (projectId, selector, before, limit) => {
      if (limit < 1) throw new Error("limit must be positive");
      const matches = [...this.eventRows.entries()]
        .filter(
          ([, e]) =>
            e.projectId === projectId &&
            e.receivedAt <= before &&
            matchesSubject(e, selector),
        )
        .sort((a, b) => eventOrder(a[1], b[1]));
      const selected = matches.slice(0, limit);
      const counts = new Map<Issue["id"], number>();
      const keys: string[] = [];
      for (const [key, e] of selected) {
        this.eventRows.delete(key);
        counts.set(e.issueId, (counts.get(e.issueId) ?? 0) + 1);
        if (e.payloadBlobKey) keys.push(e.payloadBlobKey);
      }
      return {
        deleted: selected.length,
        hasMore: matches.length > limit,
        issueCounts: [...counts].map(([issueId, count]) => ({
          issueId,
          count,
        })),
        payloadBlobKeys: keys,
      };
    },
  };
  releases: ActiveStore["releases"] = {
    get: async (projectId, id) =>
      copy(this.releaseRows.get(this.key(projectId, id)) ?? null),
    getReleaseByVersion: async (projectId, version) =>
      copy(
        [...this.releaseRows.values()].find(
          (r) => r.projectId === projectId && r.version === version,
        ) ?? null,
      ),
    put: async (release) => {
      this.releaseRows.set(
        this.key(release.projectId, release.id),
        copy(release),
      );
    },
    list: async (projectId, cursor, limit) =>
      page(
        [...this.releaseRows.values()]
          .filter((r) => r.projectId === projectId)
          .sort((a, b) => a.id.localeCompare(b.id)),
        cursor,
        limit,
      ),
    putBundle: async (bundle) => {
      this.bundles.set(this.key(bundle.projectId, bundle.id), copy(bundle));
    },
    listBundles: async (projectId, releaseId, cursor, limit) =>
      page(
        [...this.bundles.values()]
          .filter((b) => b.projectId === projectId && b.releaseId === releaseId)
          .sort((a, b) => a.id.localeCompare(b.id)),
        cursor,
        limit,
      ),
    deleteBundle: async (projectId, bundleId) => {
      this.bundles.delete(this.key(projectId, bundleId));
    },
    findBundleByDebugId: async (projectId, debugId) =>
      copy(
        [...this.bundles.values()].find(
          (b) => b.projectId === projectId && b.debugIds.includes(debugId),
        ) ?? null,
      ),
  };
  meta: ActiveStore["meta"] = {
    getArchiveState: async (projectId) =>
      copy(this.states.get(projectId) ?? null),
    compareAndSetArchiveState: async (projectId, expected, next) => {
      if (
        (this.states.get(projectId)?.version ?? null) !== expected ||
        next.projectId !== projectId ||
        next.version !== (expected === null ? 0 : expected + 1)
      )
        throw new VersionConflictError("Archive version conflict");
      this.states.set(projectId, copy(next));
    },
    getErasureRequest: async (projectId, id) =>
      copy(this.erasures.get(this.key(projectId, id)) ?? null),
    listErasureRequests: async ({ state, projectId, cursor, limit }) =>
      page(
        [...this.erasures.values()]
          .filter(
            (r) =>
              (!state || r.state === state) &&
              (!projectId || r.projectId === projectId),
          )
          .sort((a, b) => a.id.localeCompare(b.id)),
        cursor,
        limit,
      ),
    compareAndSetErasureRequest: async (projectId, id, expected, next) => {
      const key = this.key(projectId, id);
      if (
        (this.erasures.get(key)?.version ?? null) !== expected ||
        next.projectId !== projectId ||
        next.id !== id ||
        next.version !== (expected === null ? 0 : expected + 1)
      )
        throw new VersionConflictError("Erasure version conflict");
      this.erasures.set(key, copy(next));
    },
  };
}
