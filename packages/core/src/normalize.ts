import {
  type EventId,
  type EventLevel,
  type IssueId,
  type Occurrence,
  type ProjectId,
  type StoredEvent,
  type Timestamp,
  toTimestamp,
} from "./domain.js";
import { truncateIndexedText } from "./identifier-limits.js";

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}
function truncateOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : truncateIndexedText(value);
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function exception(event: Obj): Obj {
  const ex = object(event.exception);
  return object(array(ex.values).at(-1) ?? ex);
}
function frames(event: Obj): Obj[] {
  const ex = exception(event);
  const stack = object(ex.stacktrace);
  const threads = array(object(event.threads).values).map(object);
  const fallback = object(
    threads.find((thread) => thread.crashed === true) ?? threads[0],
  );
  return array(
    stack.frames ??
      object(event.stacktrace).frames ??
      object(fallback.stacktrace).frames,
  ).map(object);
}
function message(event: Obj): string {
  return (
    string(object(event.logentry).formatted) ??
    string(event.message) ??
    string(object(event.logentry).message) ??
    "<unlabeled event>"
  );
}
function defaultGroup(event: Obj): string[] {
  const chain = array(object(event.exception).values);
  if (chain.length > 1)
    return ["chain", ...chain.flatMap((ex) => defaultGroup({ exception: ex }))];
  const ex = exception(event);
  const type = string(ex.type);
  if (!type)
    return [
      "message",
      string(object(event.logentry).message) ?? message(event),
    ];
  const all = frames(event);
  const inApp = all.filter((frame) => frame.in_app === true);
  const selected = inApp.length ? inApp : all;
  const parts = selected.map((frame) => {
    const fn = string(frame.function);
    const module = string(frame.module);
    return module || fn
      ? `${module ?? ""}:${fn ?? ""}`
      : (string(frame.filename) ?? "<unknown>");
  });
  return ["exception", type, ...parts];
}
async function digest(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
/** Group every exception in chain order, using in-app module/function frames or all frames
 * when none are in-app. Frameless exceptions use their type; messages use the unformatted
 * template. Each strategy is namespaced, and custom fingerprints expand {{ default }}.
 * SHA-256 of JSON components gives the fingerprint; IssueId hashes projectId and fingerprint. */
export async function groupEvent(
  projectId: ProjectId,
  event: Obj,
): Promise<{ fingerprint: string; issueId: IssueId }> {
  const defaults = defaultGroup(event);
  const custom = array(event.fingerprint)
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .map(String);
  const parts =
    custom.length && !(custom.length === 1 && custom[0] === "{{ default }}")
      ? [
          "custom",
          ...custom.flatMap((value) =>
            value === "{{ default }}" ? defaults : [value],
          ),
        ]
      : defaults;
  const fingerprint = await digest(JSON.stringify(parts));
  return {
    fingerprint,
    issueId: (await digest(
      JSON.stringify([projectId, fingerprint]),
    )) as IssueId,
  };
}
export function normalizeEventId(value: unknown): EventId | null {
  if (typeof value !== "string") return null;
  const id = value.replaceAll("-", "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? (id as EventId) : null;
}
/** Normalize fields without dropping a syntactically valid event: odd fields are repaired or discarded. Timestamps outside the 30 days before or one minute after receipt use receivedAt. */
export async function normalizeEvent(
  projectId: ProjectId,
  eventId: EventId,
  receivedAt: Timestamp,
  event: Obj,
): Promise<{ occurrence: Occurrence; event: StoredEvent }> {
  const eventTimestamp = event.timestamp;
  let timestamp = receivedAt;
  let ms = Number.NaN;
  if (
    typeof eventTimestamp === "number" ||
    (typeof eventTimestamp === "string" &&
      /^-?\d+(?:\.\d+)?$/.test(eventTimestamp))
  ) {
    const value = Number(eventTimestamp);
    ms = Math.abs(value) >= 1e11 ? value : value * 1000;
  } else if (typeof eventTimestamp === "string") {
    const value = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(
      eventTimestamp,
    )
      ? `${eventTimestamp}Z`
      : eventTimestamp;
    ms = Date.parse(value);
  }
  const received = Date.parse(receivedAt);
  if (
    Number.isFinite(ms) &&
    ms >= received - 30 * 86400000 &&
    ms <= received + 60000
  )
    timestamp = toTimestamp(new Date(ms));
  const known: EventLevel[] = ["fatal", "error", "warning", "info", "debug"];
  const rawLevel = string(event.level);
  const level =
    rawLevel === "log"
      ? "info"
      : rawLevel === "critical"
        ? "fatal"
        : (known.find((v) => v === rawLevel) ?? "error");
  const ex = exception(event);
  const type = string(ex.type) ?? "default";
  const exValue = string(ex.value);
  const titleRaw = string(ex.type)
    ? `${ex.type}${exValue ? `: ${exValue}` : ""}`
    : message(event);
  const title = titleRaw.split(/\r?\n/, 1)[0]?.slice(0, 200) ?? "";
  const allFrames = frames(event);
  const selected = allFrames.filter((f) => f.in_app === true);
  const usable = (v: unknown) => {
    const s = string(v);
    return s && s !== "?" && s !== "<anonymous>" ? s : undefined;
  };
  const candidates = [...(selected.length ? selected : allFrames)].reverse();
  const culprit = (
    usable(event.culprit) ??
    candidates
      .flatMap((f) => [
        usable(f.function),
        usable(f.module),
        usable(f.filename),
      ])
      .find(Boolean) ??
    ""
  ).slice(0, 200);
  const metadata: Obj = {};
  if (string(ex.type)) metadata.type = String(ex.type).slice(0, 200);
  if (exValue) metadata.value = exValue.slice(0, 200);
  const tags: Record<string, string> = {};
  if (Array.isArray(event.tags)) {
    for (const pair of event.tags)
      if (
        Array.isArray(pair) &&
        typeof pair[0] === "string" &&
        ["string", "number", "boolean"].includes(typeof pair[1])
      )
        tags[pair[0]] = String(pair[1]);
  } else
    for (const [key, value] of Object.entries(object(event.tags)))
      if (["string", "number", "boolean"].includes(typeof value))
        tags[key] = String(value);
  const rawUser = object(event.user);
  const user = {
    id: ["string", "number", "boolean"].includes(typeof rawUser.id)
      ? truncateOptional(String(rawUser.id))
      : undefined,
    email: truncateOptional(string(rawUser.email)),
    username: truncateOptional(string(rawUser.username)),
    ipAddress:
      rawUser.ip_address === "{{auto}}"
        ? undefined
        : truncateOptional(string(rawUser.ip_address)),
  };
  const { fingerprint, issueId } = await groupEvent(projectId, event);
  const occurrence: Occurrence = {
    projectId,
    issueId,
    eventId,
    receivedAt,
    timestamp,
    fingerprint,
    title,
    culprit,
    level,
    type,
    metadata,
  };
  const stored: StoredEvent = {
    projectId,
    issueId,
    eventId,
    receivedAt,
    timestamp,
    level,
    tags,
    payload: event,
    ...(string(event.release)
      ? { release: truncateIndexedText(string(event.release) as string) }
      : {}),
    ...(string(event.environment)
      ? {
          environment: truncateIndexedText(string(event.environment) as string),
        }
      : {}),
    ...(Object.values(user).some(Boolean) ? { user } : {}),
  };
  return { occurrence, event: stored };
}
