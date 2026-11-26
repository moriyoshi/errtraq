import { describe, expect, it } from "vitest";
import eventFixture from "../../../testing/fixtures/sentry-api/event.json";
import issueFixture from "../../../testing/fixtures/sentry-api/issue.json";
import {
  breadcrumbsSchema,
  exceptionSchema,
  headerPairs,
  requestSchema,
} from "./entries";
import {
  eventSchema,
  issueSchema,
  organizationSchema,
  projectSchema,
  whoamiSchema,
} from "./schemas";

describe("schemas against the testing fixtures", () => {
  it("parses the issue fixture", () => {
    const issue = issueSchema.parse(issueFixture);
    expect(issue).toMatchObject({
      id: "issue",
      status: "unresolved",
      count: "1",
    });
  });

  it("parses the event fixture and defaults missing sections", () => {
    const event = eventSchema.parse(eventFixture);
    expect(event.eventID).toBe("event");
    expect(event.tags).toEqual([{ key: "region", value: "test" }]);
    expect(event.previousEventID).toBeUndefined();
    expect(eventSchema.parse({ id: "a", eventID: "a" }).entries).toEqual([]);
  });

  it("accepts neighbour ids as string or null", () => {
    const base = { id: "a", eventID: "a" };
    expect(
      eventSchema.parse({ ...base, previousEventID: null, nextEventID: "b" }),
    ).toMatchObject({ previousEventID: null, nextEventID: "b" });
  });

  it("accepts Sentry-style releases and numeric counts", () => {
    expect(
      eventSchema.parse({ id: "a", eventID: "a", release: { version: "1.2" } })
        .release,
    ).toBe("1.2");
    expect(issueSchema.parse({ ...issueFixture, count: 7 }).count).toBe("7");
  });

  it("rejects responses missing identifiers", () => {
    expect(issueSchema.safeParse({ title: "x" }).success).toBe(false);
    expect(organizationSchema.safeParse({ id: "1" }).success).toBe(false);
  });

  it("parses projects with and without extras", () => {
    const org = { id: "1", slug: "o", name: "O" };
    expect(
      projectSchema.parse({
        id: "2",
        slug: "p",
        name: "P",
        organization: org,
        errtraq: { retentionDays: 30 },
      }).slug,
    ).toBe("p");
    expect(
      projectSchema.parse({ id: "2", slug: "p", name: "P" }).organization,
    ).toBeUndefined();
  });

  it("treats the errtraq extension and scopes as optional (Sentry, GlitchTip)", () => {
    expect(whoamiSchema.parse({ user: null })).toEqual({});
    expect(
      whoamiSchema.parse({
        auth: { scopes: ["event:read"] },
        errtraq: { capabilities: { textSearch: true } },
      }).errtraq?.capabilities?.textSearch,
    ).toBe(true);
  });
});

describe("entry schemas", () => {
  it("parses an exception chain with frames", () => {
    const parsed = exceptionSchema.parse({
      values: [
        {
          type: "Error",
          value: "boom",
          mechanism: { type: "generic", handled: true },
          stacktrace: {
            frames: [
              { filename: "a.js", lineno: 1, in_app: true, context_line: "x" },
              { filename: "b.js", pre_context: ["a"], post_context: [] },
            ],
          },
        },
      ],
    });
    expect(parsed[0]?.stacktrace?.frames).toHaveLength(2);
  });

  it("accepts an empty exception (the fixture) and absent values", () => {
    expect(exceptionSchema.parse({ values: [] })).toEqual([]);
    expect(exceptionSchema.parse({})).toEqual([]);
  });

  it("rejects malformed frames so the view can fall back", () => {
    expect(
      exceptionSchema.safeParse({
        values: [{ stacktrace: { frames: [{ lineno: "x" }] } }],
      }).success,
    ).toBe(false);
  });

  it("parses breadcrumbs with numeric or ISO timestamps", () => {
    const parsed = breadcrumbsSchema.parse({
      values: [
        { timestamp: 1700000000.5, message: "m" },
        { timestamp: "2024-01-01T00:00:00Z" },
      ],
    });
    expect(parsed).toHaveLength(2);
    // errtraq passes the SDK payload through as a bare array
    expect(breadcrumbsSchema.parse([{ message: "m" }])).toHaveLength(1);
  });

  it("normalises header shapes", () => {
    expect(headerPairs([["A", "1"]])).toEqual([["A", "1"]]);
    expect(headerPairs({ B: 2 })).toEqual([["B", "2"]]);
    expect(headerPairs(undefined)).toEqual([]);
    expect(
      requestSchema.parse({ url: "https://x/", headers: [["a", "b"]] }).url,
    ).toBe("https://x/");
  });
});
