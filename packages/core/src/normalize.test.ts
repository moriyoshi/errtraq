import { describe, expect, it } from "vitest";
import { type EventId, type ProjectId, toTimestamp } from "./domain.js";
import { groupEvent, normalizeEvent, normalizeEventId } from "./normalize.js";

const project = "1" as ProjectId;
const eventId = "0123456789abcdef0123456789abcdef" as EventId;
const now = toTimestamp(new Date("2024-01-02T00:00:00Z"));
describe("grouping and event normalization", () => {
  it("groups exceptions by type and in-app frames, ignoring non-app frames", async () => {
    const sample = {
      exception: {
        values: [
          {
            type: "TypeError",
            value: "one",
            stacktrace: {
              frames: [
                { filename: "vendor.js", in_app: false },
                { module: "app", function: "handle", in_app: true },
              ],
            },
          },
        ],
      },
    };
    const changed = {
      exception: {
        values: [
          {
            type: "TypeError",
            value: "other",
            stacktrace: {
              frames: [
                { filename: "different.js", in_app: false },
                { module: "app", function: "handle", in_app: true },
              ],
            },
          },
        ],
      },
    };
    expect(await groupEvent(project, sample)).toEqual(
      await groupEvent(project, changed),
    );
    expect((await groupEvent("2" as ProjectId, sample)).issueId).not.toBe(
      (await groupEvent(project, sample)).issueId,
    );
  });
  it("expands client default fingerprint and distinguishes explicit overrides", async () => {
    const base = { message: "hello" };
    expect(
      await groupEvent(project, { ...base, fingerprint: ["{{ default }}"] }),
    ).toEqual(await groupEvent(project, base));
    expect(
      (await groupEvent(project, { ...base, fingerprint: ["custom"] })).issueId,
    ).not.toBe((await groupEvent(project, base)).issueId);
    expect((await groupEvent(project, { message: "other" })).issueId).not.toBe(
      (await groupEvent(project, base)).issueId,
    );
  });
  it("normalizes exception fields and promoted values", async () => {
    const result = await normalizeEvent(project, eventId, now, {
      timestamp: 1704067200.25,
      level: "warning",
      release: "v1",
      environment: "prod",
      tags: [["region", "jp"]],
      user: { id: "7", email: "x@y", username: "u", ip_address: "1.2.3.4" },
      exception: {
        values: [
          {
            type: "Error",
            value: "broken",
            stacktrace: { frames: [{ filename: "app.js", in_app: true }] },
          },
        ],
      },
    });
    expect(result.occurrence).toMatchObject({
      title: "Error: broken",
      culprit: "app.js",
      type: "Error",
      timestamp: "2024-01-01T00:00:00.250Z",
      level: "warning",
    });
    expect(result.event).toMatchObject({
      release: "v1",
      environment: "prod",
      tags: { region: "jp" },
      user: { id: "7", email: "x@y", username: "u", ipAddress: "1.2.3.4" },
    });
  });
  it("handles message and logentry forms, object tags and ISO timestamps", async () => {
    const a = await normalizeEvent(project, eventId, now, {
      logentry: { message: "hello %s", formatted: "hello world" },
      tags: { a: "b" },
      timestamp: "2024-01-01T00:00:00Z",
    });
    expect(a.occurrence.title).toBe("hello world");
    expect(a.event.tags).toEqual({ a: "b" });
    expect(a.event.timestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(normalizeEventId("01234567-89ab-cdef-0123-456789abcdef")).toBe(
      eventId,
    );
  });
  it.each([
    {
      left: { message: "same" },
      right: { logentry: { formatted: "same" } },
      same: true,
    },
    { left: { message: "first" }, right: { message: "second" }, same: false },
    {
      left: { message: "one", fingerprint: ["custom"] },
      right: { message: "two", fingerprint: ["custom"] },
      same: true,
    },
    {
      left: { message: "one", fingerprint: ["custom", "{{ default }}"] },
      right: { message: "two", fingerprint: ["custom", "{{ default }}"] },
      same: false,
    },
  ])("groups fixture pairs (same=$same)", async ({ left, right, same }) => {
    expect(
      (await groupEvent(project, left)).issueId ===
        (await groupEvent(project, right)).issueId,
    ).toBe(same);
  });
  it("repairs odd timestamps and fields without dropping events", async () => {
    for (const timestamp of [null, "garbage", 1e20, 4e12])
      expect(
        (await normalizeEvent(project, eventId, now, { timestamp })).event
          .timestamp,
      ).toBe(now);
    for (const timestamp of [
      "1704067200",
      1704067200000,
      "2024-01-01T00:00:00",
    ])
      expect(
        (await normalizeEvent(project, eventId, now, { timestamp })).event
          .timestamp,
      ).toBe("2024-01-01T00:00:00.000Z");
    const result = await normalizeEvent(project, eventId, now, {
      level: "critical",
      tags: { n: 5, b: false },
      user: { id: 42, ip_address: "{{auto}}" },
      exception: {
        type: "Error",
        value: "line\nmore",
        stacktrace: { frames: [{ function: "?", filename: "good.js" }] },
      },
    });
    expect(result.event).toMatchObject({
      level: "fatal",
      tags: { n: "5", b: "false" },
      user: { id: "42" },
    });
    expect(result.event.user?.ipAddress).toBeUndefined();
    expect(result.occurrence).toMatchObject({
      title: "Error: line",
      culprit: "good.js",
      type: "Error",
    });
    expect(
      (await normalizeEvent(project, eventId, now, { level: "log" })).event
        .level,
    ).toBe("info");
    expect(
      (await normalizeEvent(project, eventId, now, { level: "unknown" })).event
        .level,
    ).toBe("error");
  });
  it("groups templates and namespaces custom and chained strategies", async () => {
    expect(
      await groupEvent(project, {
        logentry: { message: "hello %s", formatted: "hello one" },
      }),
    ).toEqual(
      await groupEvent(project, {
        logentry: { message: "hello %s", formatted: "hello two" },
      }),
    );
    expect(
      (await groupEvent(project, { exception: { type: "TypeError" } }))
        .fingerprint,
    ).not.toBe(
      (await groupEvent(project, { fingerprint: ["exception", "TypeError"] }))
        .fingerprint,
    );
    expect(await groupEvent(project, { fingerprint: [2, true] })).toEqual(
      await groupEvent(project, { fingerprint: ["2", "true"] }),
    );
    expect(
      (
        await groupEvent(project, {
          exception: { values: [{ type: "First" }, { type: "Last" }] },
        })
      ).fingerprint,
    ).not.toBe(
      (
        await groupEvent(project, {
          exception: { values: [{ type: "Other" }, { type: "Last" }] },
        })
      ).fingerprint,
    );
  });
  it("falls back to all frames and filename when no frame is in-app", async () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: { frames: [{ filename: "one.js", in_app: false }] },
          },
        ],
      },
    };
    const changed = {
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: { frames: [{ filename: "two.js", in_app: false }] },
          },
        ],
      },
    };
    expect((await groupEvent(project, event)).issueId).not.toBe(
      (await groupEvent(project, changed)).issueId,
    );
    expect(
      (await normalizeEvent(project, eventId, now, { timestamp: "not-a-date" }))
        .event.timestamp,
    ).toBe(now);
  });
});
