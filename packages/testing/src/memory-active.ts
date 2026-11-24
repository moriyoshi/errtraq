import {
  type ActiveStore,
  type ApiToken,
  type ArchiveState,
  type ArtifactBundle,
  bundleDebugIdsDigest,
  type Clock,
  ConflictError,
  type ErasureRequest,
  type Issue,
  NotFoundError,
  type Org,
  type Project,
  type ProjectKey,
  type Release,
  type StoredEvent,
  summarizeApiToken,
  UnsupportedQueryError,
  VersionConflictError,
  withIdentifierLimits,
} from "@moriyoshi/errtraq-core";
import { compareKeys, copy, eventOrder, eventPage, page } from "./shared.js";

export class MemoryActiveStore implements ActiveStore {
  readonly capabilities = {
    lastSeenRangeOnOtherSort: false,
    textSearch: false,
    recordEvents: true,
  };
  private orgs = new Map<string, Org>();
  private projectRows = new Map<string, Project>();
  private keys = new Map<string, ProjectKey>();
  private tokens = new Map<string, ApiToken>();
  private issueRows = new Map<string, Issue>();
  private eventRows = new Map<string, StoredEvent>();
  private releaseRows = new Map<string, Release>();
  private bundles = new Map<string, ArtifactBundle>();
  private bundleMarkers = new Map<string, string>();
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
    // biome-ignore lint/correctness/noConstructorReturn: the guard proxy is the store every caller receives
    return withIdentifierLimits(this);
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
      if (
        [...this.orgs.values()].some(
          (row) => row.slug === org.slug && row.id !== org.id,
        )
      )
        throw new ConflictError("Organization slug exists");
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
      if (
        [...this.projectRows.values()].some(
          (row) =>
            row.orgId === project.orgId &&
            row.slug === project.slug &&
            row.id !== project.id,
        )
      )
        throw new ConflictError("Project slug exists");
      this.projectRows.set(project.id, copy(project));
    },
    list: async (cursor, limit) =>
      page(
        [...this.projectRows.values()].sort((a, b) =>
          compareKeys([a.id], [b.id]),
        ),
        cursor,
        limit,
        (p) => [p.id],
        "projects",
      ),
    getKey: async (key) => copy(this.keys.get(key) ?? null),
    putKey: async (key) => {
      const other = this.keys.get(key.publicKey);
      if (other && other.id !== key.id) throw new ConflictError("Key exists");
      for (const [value, row] of this.keys)
        if (row.id === key.id && value !== key.publicKey)
          this.keys.delete(value);
      this.keys.set(key.publicKey, copy(key));
    },
    getOrCreateActiveKey: async (key) => {
      const existing = [...this.keys.values()].find(
        (row) => row.projectId === key.projectId && !row.revokedAt,
      );
      if (existing) return copy(existing);
      if (this.keys.has(key.publicKey)) throw new ConflictError("Key exists");
      this.keys.set(key.publicKey, copy(key));
      return copy(key);
    },
    listKeys: async (projectId) =>
      copy(
        [...this.keys.values()].filter((key) => key.projectId === projectId),
      ),
    getTokenByHash: async (hash) => copy(this.tokens.get(hash) ?? null),
    createToken: async (token) => {
      if (this.tokens.has(token.tokenHash)) return false;
      if ([...this.tokens.values()].some((row) => row.id === token.id))
        throw new ConflictError("Token ID exists");
      this.tokens.set(token.tokenHash, copy(token));
      return true;
    },
    putToken: async (token) => {
      const other = this.tokens.get(token.tokenHash);
      if (other && other.id !== token.id)
        throw new ConflictError("Token exists");
      for (const [value, row] of this.tokens)
        if (row.id === token.id && value !== token.tokenHash)
          this.tokens.delete(value);
      this.tokens.set(token.tokenHash, copy(token));
    },
    listTokens: async (orgId, cursor, limit) =>
      page(
        [...this.tokens.values()]
          .filter((token) => token.orgId === orgId)
          .sort((a, b) => compareKeys([a.id], [b.id]))
          .map(summarizeApiToken),
        cursor,
        limit,
        (token) => [token.id],
        JSON.stringify(["tokens", orgId]),
      ),
    revokeToken: async (orgId, id, at) => {
      for (const [hash, row] of this.tokens)
        if (row.id === id && row.orgId === orgId) {
          if (!row.revokedAt) this.tokens.set(hash, { ...row, revokedAt: at });
          return summarizeApiToken(copy(this.tokens.get(hash) as ApiToken));
        }
      return null;
    },
  };
  private recordOne: (
    occurrence: import("@moriyoshi/errtraq-core").Occurrence,
    event: StoredEvent,
  ) => import("@moriyoshi/errtraq-core").RecordResult = (occurrence, event) => {
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

  recordEvent: ActiveStore["recordEvent"] = async (occurrence, event) =>
    this.recordOne(occurrence, event);

  recordEvents: ActiveStore["recordEvents"] = async (group) => {
    if (!Array.isArray(group) || group.length < 1 || group.length > 10)
      throw new RangeError("Record group must contain 1 to 10 events");
    const first = group[0]?.occurrence;
    if (!first) throw new TypeError("Missing record group");
    for (const { occurrence, event } of group) {
      if (
        occurrence.projectId !== first.projectId ||
        occurrence.issueId !== first.issueId ||
        occurrence.fingerprint !== first.fingerprint ||
        occurrence.projectId !== event.projectId ||
        occurrence.issueId !== event.issueId ||
        occurrence.eventId !== event.eventId ||
        occurrence.receivedAt !== event.receivedAt
      )
        throw new TypeError("Record group identity mismatch");
      copy(occurrence);
      copy(event);
    }
    const oldIssues = new Map(this.issueRows),
      oldEvents = new Map(this.eventRows);
    try {
      const results = group.map(({ occurrence, event }) =>
        this.recordOne(occurrence, event),
      );
      const final = this.issueRows.get(
        this.key(first.projectId, first.fingerprint),
      );
      return results.map((result) =>
        final &&
        result.issue.projectId === first.projectId &&
        result.issue.id === first.issueId
          ? { ...result, issue: copy(final) }
          : result,
      );
    } catch (error) {
      this.issueRows = oldIssues;
      this.eventRows = oldEvents;
      throw error;
    }
  };

  issues: ActiveStore["issues"] = {
    getById: async (id) =>
      copy([...this.issueRows.values()].filter((issue) => issue.id === id)),
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
        return av < bv ? 1 : av > bv ? -1 : compareKeys([a.id], [b.id]);
      });
      return page(
        rows,
        query.cursor,
        query.limit,
        (issue) => [issue[query.sort], issue.id],
        JSON.stringify([
          "issues",
          query.projectId,
          query.sort,
          query.status ?? null,
          query.from ?? null,
          query.to ?? null,
        ]),
        (a, b) =>
          -compareKeys([a[0] ?? ""], [b[0] ?? ""]) ||
          compareKeys([a[1] ?? ""], [b[1] ?? ""]),
      );
    },
    repairAfterErasure: async () => {
      throw new UnsupportedQueryError(
        "Subject erasure is unavailable until M4",
      );
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
    capabilities: { deleteStrategy: "explicit", deleteBySubject: false },
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
      return page(
        all,
        options?.cursor,
        options?.limit,
        (event) => [event.receivedAt, event.eventId],
        JSON.stringify(["scan", projectId, cutoff]),
      );
    },
    deleteBatch: async (projectId, ids) => {
      for (const id of ids) this.eventRows.delete(this.key(projectId, id));
    },
    deleteBySubject: async () => {
      throw new UnsupportedQueryError(
        "Subject erasure is unavailable until M4",
      );
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
      if (
        [...this.releaseRows.values()].some(
          (row) =>
            row.projectId === release.projectId &&
            row.version === release.version &&
            row.id !== release.id,
        )
      )
        throw new ConflictError("Release version exists");
      this.releaseRows.set(
        this.key(release.projectId, release.id),
        copy(release),
      );
    },
    list: async (projectId, cursor, limit) =>
      page(
        [...this.releaseRows.values()]
          .filter((r) => r.projectId === projectId)
          .sort((a, b) => compareKeys([a.id], [b.id])),
        cursor,
        limit,
        (r) => [r.id],
        JSON.stringify(["releases", projectId]),
      ),
    beginBundle: async (bundle, manifest) => {
      if (
        bundle.state !== "pending" ||
        !bundle.pendingExpiresAt ||
        JSON.stringify(bundle.manifest) !== JSON.stringify(manifest)
      )
        throw new ConflictError("Invalid pending bundle");
      const key = this.key(bundle.projectId, bundle.id);
      const old = this.bundles.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(bundle))
        throw new ConflictError("Bundle already exists");
      this.bundles.set(key, copy(bundle));
    },
    putBundleDebugIds: async (projectId, bundleId, ids, manifestIds) => {
      const digest = await bundleDebugIdsDigest(manifestIds);
      const key = this.key(projectId, bundleId),
        bundle = this.bundles.get(key);
      if (bundle?.state !== "pending" || bundle.cleanupStarted)
        throw new ConflictError("Bundle is not pending");
      const expected = new Set(manifestIds);
      if (
        ids.length > 100 ||
        expected.size !== manifestIds.length ||
        manifestIds.length !== bundle.manifest.debugIdCount ||
        digest !== bundle.manifest.digest ||
        ids.some((id) => !expected.has(id))
      )
        throw new ConflictError("Chunk does not match bundle manifest");
      for (const id of ids) {
        const owner = this.bundleMarkers.get(this.key(projectId, id));
        if (owner && owner !== key)
          throw new ConflictError("Debug ID already owned");
      }
      for (const id of ids)
        this.bundleMarkers.set(this.key(projectId, id), key);
    },
    verifyAndActivateBundle: async (projectId, bundleId, ids) => {
      const key = this.key(projectId, bundleId);
      const digest = await bundleDebugIdsDigest(ids);
      const bundle = this.bundles.get(key);
      if (!bundle || bundle.cleanupStarted)
        throw new ConflictError("Bundle not found or being cleaned");
      if (
        new Set(ids).size !== ids.length ||
        ids.length !== bundle.manifest.debugIdCount ||
        digest !== bundle.manifest.digest ||
        ids.some(
          (id) => this.bundleMarkers.get(this.key(projectId, id)) !== key,
        ) ||
        [...this.bundleMarkers.values()].filter((owner) => owner === key)
          .length !== ids.length
      )
        throw new ConflictError("Bundle manifest does not match markers");
      bundle.state = "active";
      delete bundle.pendingExpiresAt;
    },
    listPendingBundles: async (projectId, before, cursor, limit) =>
      page(
        [...this.bundles.values()]
          .filter(
            (b) =>
              b.projectId === projectId &&
              b.state === "pending" &&
              !!b.pendingExpiresAt &&
              b.pendingExpiresAt <= before,
          )
          .sort((a, b) => compareKeys([a.id], [b.id])),
        cursor,
        limit,
        (b) => [b.id],
        JSON.stringify(["pending-bundles", projectId, before]),
      ),
    claimPendingBundleCleanup: async (projectId, bundleId, before) => {
      const bundle = this.bundles.get(this.key(projectId, bundleId));
      if (
        bundle?.state !== "pending" ||
        !bundle.pendingExpiresAt ||
        bundle.pendingExpiresAt > before
      )
        return null;
      bundle.cleanupStarted = true;
      bundle.cleanupId ??= crypto.randomUUID();
      return copy(bundle);
    },
    clearPendingBundleDebugIds: async (projectId, bundleId, ids, cleanupId) => {
      const digest = await bundleDebugIdsDigest(ids);
      const key = this.key(projectId, bundleId),
        bundle = this.bundles.get(key);
      if (
        bundle?.state !== "pending" ||
        !bundle.cleanupStarted ||
        bundle.cleanupId !== cleanupId
      )
        throw new ConflictError("Bundle cleanup not claimed");
      if (bundle.cleanupMarkersCleared) return;
      if (
        ids.length !== bundle.manifest.debugIdCount ||
        new Set(ids).size !== ids.length ||
        digest !== bundle.manifest.digest
      )
        throw new ConflictError("Invalid bundle manifest");
      const expected = new Set(ids.map((id) => this.key(projectId, id)));
      for (const [marker, owner] of this.bundleMarkers)
        if (owner === key && !expected.has(marker))
          throw new ConflictError("Unexpected bundle marker");
      for (const [marker, owner] of this.bundleMarkers)
        if (owner === key) this.bundleMarkers.delete(marker);
      bundle.cleanupMarkersCleared = true;
    },
    finishPendingBundleCleanup: async (projectId, bundleId, cleanupId) => {
      const key = this.key(projectId, bundleId),
        bundle = this.bundles.get(key);
      if (!bundle) return;
      if (
        bundle.state !== "pending" ||
        !bundle.cleanupMarkersCleared ||
        bundle.cleanupId !== cleanupId
      )
        throw new ConflictError("Bundle cleanup claim changed");
      this.bundles.delete(key);
    },
    listBundles: async (projectId, releaseId, cursor, limit) =>
      page(
        [...this.bundles.values()]
          .filter((b) => b.projectId === projectId && b.releaseId === releaseId)
          .sort((a, b) => compareKeys([a.id], [b.id])),
        cursor,
        limit,
        (b) => [b.id],
        JSON.stringify(["bundles", projectId, releaseId]),
      ),
    deleteBundle: async (projectId, bundleId) => {
      const key = this.key(projectId, bundleId);
      if (this.bundles.get(key)?.state === "pending")
        throw new ConflictError("Pending bundles require the cleanup protocol");
      this.bundles.delete(key);
      for (const [marker, owner] of this.bundleMarkers)
        if (owner === key) this.bundleMarkers.delete(marker);
    },
    findBundleByDebugId: async (projectId, debugId) =>
      copy(
        [...this.bundles.values()].find(
          (b) =>
            b.projectId === projectId &&
            b.state === "active" &&
            this.bundleMarkers.get(this.key(projectId, debugId)) ===
              this.key(projectId, b.id),
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
          .sort(
            (a, b) =>
              compareKeys([a.projectId], [b.projectId]) ||
              compareKeys([a.id], [b.id]),
          ),
        cursor,
        limit,
        (r) => [r.projectId, r.id],
        JSON.stringify(["erasures", projectId ?? null, state ?? null]),
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
