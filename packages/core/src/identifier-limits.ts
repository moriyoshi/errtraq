import { InvalidIdentifierError } from "./errors.js";
import type { ActiveStore } from "./ports.js";

/**
 * Shared, store-independent bounds for values that stores index or use in keys.
 *
 * Postgres indexes `varchar(255)` columns and serialized composite keys
 * (`JSON.stringify([projectId, id])`); DynamoDB and the memory fake use the same
 * composite shape. One rule is enforced by every store so behaviour never differs:
 *
 * - Identifiers (organization, project, key, token, issue, event, release, bundle and
 *   erasure IDs) are 1..100 characters from a conservative ASCII alphabet that never
 *   needs JSON escaping, so a two-part key is at most 207 characters.
 * - Indexed text (slugs, public keys, token hashes, release versions, fingerprints, debug
 *   IDs and user / release / environment values on events) is at most 255 UTF-8 bytes. Bytes
 *   bound both Postgres characters and the btree row size.
 */
export const MAX_IDENTIFIER_LENGTH = 100;
export const MAX_INDEXED_TEXT_BYTES = 255;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+=~-]*$/;
const encoder = new TextEncoder();

export function assertIdentifier(name: string, value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER.test(value)
  )
    throw new InvalidIdentifierError(
      `${name} must be 1-${MAX_IDENTIFIER_LENGTH} characters of A-Z a-z 0-9 . _ : @ + = ~ - starting with a letter or digit`,
    );
}

/** Optional values (undefined or null) pass; anything present must fit the byte bound. */
export function assertIndexedText(name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (
    typeof value !== "string" ||
    // UTF-8 never needs fewer bytes than UTF-16 code units, so short strings skip encoding.
    (value.length > MAX_INDEXED_TEXT_BYTES / 3 &&
      encoder.encode(value).length > MAX_INDEXED_TEXT_BYTES)
  )
    throw new InvalidIdentifierError(
      `${name} must be a string of at most ${MAX_INDEXED_TEXT_BYTES} UTF-8 bytes`,
    );
}

/** Truncate at a code point boundary so the result satisfies assertIndexedText. */
export function truncateIndexedText(value: string): string {
  if (
    value.length <= MAX_INDEXED_TEXT_BYTES / 3 ||
    encoder.encode(value).length <= MAX_INDEXED_TEXT_BYTES
  )
    return value;
  let bytes = 0;
  let out = "";
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > MAX_INDEXED_TEXT_BYTES) break;
    bytes += size;
    out += char;
  }
  return out;
}

function ids(prefix: string, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values))
    assertIdentifier(`${prefix}${key}`, value);
}
function texts(prefix: string, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values))
    assertIndexedText(`${prefix}${key}`, value);
}

type Occurrence = Parameters<ActiveStore["recordEvent"]>[0];
type Event = Parameters<ActiveStore["recordEvent"]>[1];
function checkRecord(occurrence: Occurrence, event: Event): void {
  ids("occurrence.", {
    projectId: occurrence.projectId,
    issueId: occurrence.issueId,
    eventId: occurrence.eventId,
  });
  assertIndexedText("occurrence.fingerprint", occurrence.fingerprint);
  ids("event.", {
    projectId: event.projectId,
    issueId: event.issueId,
    eventId: event.eventId,
  });
  texts("event.", {
    release: event.release,
    environment: event.environment,
    "user.id": event.user?.id,
    "user.email": event.user?.email,
    "user.username": event.user?.username,
    "user.ipAddress": event.user?.ipAddress,
  });
}

function guarded<T extends object>(
  target: T,
  checks: Partial<Record<keyof T, (...args: never[]) => void>>,
): T {
  return new Proxy(target, {
    get(t, property) {
      const value = Reflect.get(t, property, t);
      if (typeof value !== "function") return value;
      const check = (checks as Record<PropertyKey, unknown>)[property] as
        | ((...args: unknown[]) => void)
        | undefined;
      if (!check) return value.bind(t);
      return async (...args: unknown[]) => {
        // Validation failures reject asynchronously like any store error.
        check(...args);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/**
 * Wrap a store so every write validates identifiers and indexed text with the shared rule
 * before touching the backend. Reads pass through: an over-long lookup simply misses.
 * Failures reject with InvalidIdentifierError. Non-port members (close, table, ...) are
 * forwarded bound to the original store.
 */
export function withIdentifierLimits<T extends ActiveStore>(store: T): T {
  const projects = guarded(store.projects, {
    putOrg: (org: { id: string; slug: string }) => {
      assertIdentifier("org.id", org.id);
      assertIndexedText("org.slug", org.slug);
    },
    put: (p: { id: string; orgId: string; slug: string }) => {
      ids("project.", { id: p.id, orgId: p.orgId });
      assertIndexedText("project.slug", p.slug);
    },
    putKey: checkKey,
    getOrCreateActiveKey: checkKey,
    createToken: checkToken,
    putToken: checkToken,
  } as never);
  const issues = guarded(store.issues, {
    update: (projectId: string, issueId: string) =>
      ids("", { projectId, issueId }),
  } as never);
  const releases = guarded(store.releases, {
    put: (r: { id: string; projectId: string; version: string }) => {
      ids("release.", { id: r.id, projectId: r.projectId });
      assertIndexedText("release.version", r.version);
    },
    beginBundle: (b: { id: string; projectId: string; releaseId: string }) =>
      ids("bundle.", {
        id: b.id,
        projectId: b.projectId,
        releaseId: b.releaseId,
      }),
    putBundleDebugIds: (
      projectId: string,
      bundleId: string,
      debugIds: readonly string[],
    ) => {
      ids("", { projectId, bundleId });
      for (const id of debugIds) assertIndexedText("debugId", id);
    },
    verifyAndActivateBundle: (
      projectId: string,
      bundleId: string,
      debugIds: readonly string[],
    ) => {
      ids("", { projectId, bundleId });
      for (const id of debugIds) assertIndexedText("debugId", id);
    },
  } as never);
  const meta = guarded(store.meta, {
    compareAndSetArchiveState: (projectId: string) => ids("", { projectId }),
    compareAndSetErasureRequest: (projectId: string, id: string) =>
      ids("", { projectId, erasureId: id }),
  } as never);
  const overrides: Record<PropertyKey, unknown> = {
    projects,
    issues,
    releases,
    meta,
    recordEvent: async (occurrence: Occurrence, event: Event) => {
      checkRecord(occurrence, event);
      return store.recordEvent(occurrence, event);
    },
    recordEvents: async (group: Parameters<ActiveStore["recordEvents"]>[0]) => {
      for (const item of group) checkRecord(item.occurrence, item.event);
      return store.recordEvents(group);
    },
  };
  return new Proxy(store, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    // Replacing a guarded member (for example a test spy) replaces the guarded entry point.
    set(target, property, value) {
      if (property in overrides) {
        overrides[property] = value;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
    defineProperty(target, property, descriptor) {
      if (property in overrides && "value" in descriptor) {
        overrides[property] = descriptor.value;
        return true;
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
}
function checkKey(key: { id: string; projectId: string; publicKey: string }) {
  ids("key.", { id: key.id, projectId: key.projectId });
  assertIndexedText("key.publicKey", key.publicKey);
}
function checkToken(token: { id: string; orgId: string; tokenHash: string }) {
  ids("token.", { id: token.id, orgId: token.orgId });
  assertIndexedText("token.tokenHash", token.tokenHash);
}
