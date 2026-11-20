import {
  type ActiveStore,
  type ApiToken,
  type ArchiveState,
  type ArtifactBundle,
  type ErasureRequest,
  type Issue,
  NotFoundError,
  type Occurrence,
  type Org,
  type Project,
  type ProjectKey,
  type Release,
  type StoredEvent,
  UnsupportedQueryError,
  VersionConflictError,
} from "@errtraq/core";
import {
  copy,
  DeterministicIdGen,
  eventOrder,
  matchesSubject,
  page,
} from "./shared.js";

export class MemoryActiveStore implements ActiveStore {
  readonly capabilities = {
    tagFilter: "indexed-only" as const,
    textSearch: false,
    transactions: false,
  };
  private ids = new DeterministicIdGen();
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
  async migrate(): Promise<void> {}
  projects: ActiveStore["projects"] = {
    getOrg: async (id) => copy(this.orgs.get(id) ?? null),
    putOrg: async (org) => {
      this.orgs.set(org.id, copy(org));
    },
    get: async (id) => copy(this.projectRows.get(id) ?? null),
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
    getTokenByHash: async (hash) => copy(this.tokens.get(hash) ?? null),
    putToken: async (token) => {
      this.tokens.set(token.tokenHash, copy(token));
    },
  };
  issues: ActiveStore["issues"] = {
    recordOccurrence: async (occurrence: Occurrence) => {
      const key = this.key(occurrence.projectId, occurrence.fingerprint);
      let issue = this.issueRows.get(key);
      const isNew = !issue;
      const isRegression =
        issue?.status === "resolved" &&
        (!issue.resolvedAt || occurrence.receivedAt > issue.resolvedAt);
      if (!issue) {
        issue = {
          id: this.ids.next() as Issue["id"],
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
      return { issue: copy(issue), isNew, isRegression: !!isRegression };
    },
    get: async (projectId, id) =>
      copy(
        [...this.issueRows.values()].find(
          (i) => i.projectId === projectId && i.id === id,
        ) ?? null,
      ),
    list: async (query) => {
      if (query.text || (query.tags && Object.keys(query.tags).length))
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
    put: async (event) => {
      const key = this.key(event.projectId, event.eventId);
      if (this.eventRows.has(key)) return { inserted: false };
      this.eventRows.set(key, copy(event));
      return { inserted: true };
    },
    get: async (projectId, eventId) =>
      copy(this.eventRows.get(this.key(projectId, eventId)) ?? null),
    listByIssue: async (query) =>
      page(
        [...this.eventRows.values()]
          .filter(
            (e) =>
              e.projectId === query.projectId &&
              (!query.issueId || e.issueId === query.issueId) &&
              (!query.from || e.receivedAt >= query.from) &&
              (!query.to || e.receivedAt < query.to),
          )
          .sort(eventOrder),
        query.cursor,
        query.limit,
      ),
    scanOlderThan: async (projectId, cutoff, options) => {
      const all = [...this.eventRows.values()]
        .filter((e) => e.projectId === projectId && e.receivedAt < cutoff)
        .sort(eventOrder);
      return page(all, options?.cursor, options?.limit);
    },
    deleteBatch: async (projectId, ids) => {
      for (const id of ids) this.eventRows.delete(this.key(projectId, id));
    },
    deleteBySubject: async (projectId, selector, before) => {
      const issueIds = new Set<Issue["id"]>();
      let deleted = 0;
      for (const [key, event] of this.eventRows)
        if (
          event.projectId === projectId &&
          event.receivedAt <= before &&
          matchesSubject(event, selector)
        ) {
          this.eventRows.delete(key);
          issueIds.add(event.issueId);
          deleted++;
        }
      return { deleted, issueIds: [...issueIds] };
    },
  };
  releases: ActiveStore["releases"] = {
    get: async (projectId, id) =>
      copy(this.releaseRows.get(this.key(projectId, id)) ?? null),
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
    listErasureRequests: async (state, cursor, limit) =>
      page(
        [...this.erasures.values()]
          .filter((r) => r.state === state)
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
