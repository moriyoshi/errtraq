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
import { InvalidEnvelopeError } from "./envelope.js";

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function exception(event: Obj): Obj {
  return object(array(object(event.exception).values).at(-1));
}
function frames(event: Obj): Obj[] {
  const ex = exception(event);
  const stack = object(ex.stacktrace);
  const threads = array(object(event.threads).values).map(object);
  const fallback = object(
    threads.find((thread) => thread.crashed === true) ?? threads[0],
  );
  return array(stack.frames ?? object(fallback.stacktrace).frames).map(object);
}
function message(event: Obj): string {
  return (
    string(event.message) ??
    string(object(event.logentry).formatted) ??
    string(object(event.logentry).message) ??
    "<unlabeled event>"
  );
}
function defaultGroup(event: Obj): string[] {
  const ex = exception(event);
  const type = string(ex.type);
  if (!type) return ["message", message(event)];
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
/** Group exception type with in-app module/function frames (all frames if none are in-app),
 * or message when no exception exists. Client fingerprints replace this grouping, with each
 * {{ default }} expanded to those components. SHA-256 of the JSON components is the fingerprint;
 * IssueId is SHA-256 of JSON [projectId, fingerprint], both lower-case hexadecimal. */
export async function groupEvent(
  projectId: ProjectId,
  event: Obj,
): Promise<{ fingerprint: string; issueId: IssueId }> {
  const defaults = defaultGroup(event);
  const custom = array(event.fingerprint);
  const parts =
    custom.length && custom.every((value) => typeof value === "string")
      ? custom.flatMap((value) =>
          value === "{{ default }}" ? defaults : [value as string],
        )
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
/** Normalize Sentry fields and promoted columns while retaining the original event payload. */
export async function normalizeEvent(
  projectId: ProjectId,
  eventId: EventId,
  receivedAt: Timestamp,
  event: Obj,
): Promise<{ occurrence: Occurrence; event: StoredEvent }> {
  const eventTimestamp = event.timestamp;
  let timestamp = receivedAt;
  if (eventTimestamp !== undefined) {
    const ms =
      typeof eventTimestamp === "number"
        ? eventTimestamp * 1000
        : typeof eventTimestamp === "string"
          ? Date.parse(eventTimestamp)
          : Number.NaN;
    if (!Number.isFinite(ms))
      throw new InvalidEnvelopeError("Invalid event timestamp");
    try {
      timestamp = toTimestamp(new Date(ms));
    } catch {
      throw new InvalidEnvelopeError("Invalid event timestamp");
    }
  }
  const known: EventLevel[] = ["fatal", "error", "warning", "info", "debug"];
  const rawLevel = string(event.level);
  const level = known.find((v) => v === rawLevel) ?? "error";
  const ex = exception(event);
  const type =
    string(ex.type) ??
    (event.logentry || event.message ? "message" : "default");
  const exValue = string(ex.value);
  const title = string(ex.type)
    ? `${ex.type}${exValue ? `: ${exValue}` : ""}`
    : message(event);
  const lastFrame =
    frames(event)
      .filter((f) => f.in_app === true)
      .at(-1) ?? frames(event).at(-1);
  const culprit =
    string(event.culprit) ??
    string(lastFrame?.function) ??
    string(lastFrame?.filename) ??
    "";
  const metadata: Obj = {};
  if (string(ex.type)) metadata.type = ex.type;
  if (exValue) metadata.value = exValue;
  const tags: Record<string, string> = {};
  if (Array.isArray(event.tags)) {
    for (const pair of event.tags)
      if (
        Array.isArray(pair) &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string"
      )
        tags[pair[0]] = pair[1];
  } else
    for (const [key, value] of Object.entries(object(event.tags)))
      if (typeof value === "string") tags[key] = value;
  const rawUser = object(event.user);
  const user = {
    id: string(rawUser.id),
    email: string(rawUser.email),
    username: string(rawUser.username),
    ipAddress: string(rawUser.ip_address),
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
    ...(string(event.release) ? { release: string(event.release) } : {}),
    ...(string(event.environment)
      ? { environment: string(event.environment) }
      : {}),
    ...(Object.values(user).some(Boolean) ? { user } : {}),
  };
  return { occurrence, event: stored };
}
