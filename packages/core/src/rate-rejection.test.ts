import { describe, expect, it, vi } from "vitest";
import type { ProjectId, Timestamp } from "./domain.js";
import type { KV, Logger } from "./ports.js";
import {
  effectiveRateLimits,
  RateRejector,
  readDropped,
  validateProjectRateLimits,
} from "./rate-rejection.js";

function setup(
  config: ConstructorParameters<typeof RateRejector>[0]["config"],
) {
  const values = new Map<string, string>();
  const kv: KV = {
    increment: vi.fn(async (key, by) => {
      const count = Number(values.get(key) ?? 0) + by;
      values.set(key, String(count));
      return count;
    }),
    get: vi.fn(async (key) => values.get(key) ?? null),
    put: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      values.delete(key);
    }),
  };
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { kv, logger, rejector: new RateRejector({ kv, config, logger }) };
}
let sequence = 0;
/** Each call is a distinct event unless an explicit eventId is given. */
const candidate = (
  projectId = "1",
  issueId = "a",
  at = "2024-01-01T00:00:00.000Z",
  eventId = `e${++sequence}`,
) => ({
  projectId: projectId as ProjectId,
  issueId,
  eventId,
  receivedAt: at as Timestamp,
});

describe("rate rejection counters", () => {
  it("does not access KV when limits are disabled", async () => {
    const { kv, rejector } = setup({});
    expect(await rejector.admitIssueEvents([candidate()])).toEqual([true]);
    expect(await rejector.admitNewIssues([candidate()])).toEqual([true]);
    await rejector.recordDropped([candidate()]);
    expect(kv.increment).not.toHaveBeenCalled();
  });
  it("batches per issue and window, admitting the first events that fit", async () => {
    const { kv, rejector } = setup({
      issueRateLimit: { events: 2, windowSec: 60 },
    });
    expect(
      await rejector.admitIssueEvents([
        candidate(),
        candidate(),
        candidate(),
        candidate("2"),
      ]),
    ).toEqual([true, true, false, true]);
    // Four event markers and two issue counters.
    expect(kv.increment).toHaveBeenCalledTimes(6);
    expect(await rejector.admitIssueEvents([candidate()])).toEqual([false]);
    expect(
      await rejector.admitIssueEvents([
        candidate("1", "a", "2024-01-01T00:01:00.000Z"),
      ]),
    ).toEqual([true]);
  });
  it("caps new issue candidates per project and window", async () => {
    const { rejector } = setup({ newIssueCap: { issues: 1, windowSec: 60 } });
    expect(
      await rejector.admitNewIssues([
        candidate("1", "a"),
        candidate("1", "b"),
        candidate("2", "a"),
      ]),
    ).toEqual([true, false, true]);
    expect(
      await rejector.admitNewIssues([
        candidate("1", "c", "2024-01-01T00:01:00.000Z"),
      ]),
    ).toEqual([true]);
  });
  it("honors failure policy without logging provider details", async () => {
    for (const policy of ["allow", "retry"] as const) {
      const { kv, logger, rejector } = setup({
        issueRateLimit: { events: 1, windowSec: 60 },
        onKvFailure: policy,
      });
      const sensitive = Object.assign(new Error("secret"), {
        name: "private-user@example.test",
      });
      vi.mocked(kv.increment).mockRejectedValue(sensitive);
      if (policy === "allow") {
        expect(await rejector.admitIssueEvents([candidate()])).toEqual([true]);
        await expect(
          rejector.recordDropped([candidate()]),
        ).resolves.toBeUndefined();
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
          "private-user",
        );
      } else {
        await expect(rejector.admitIssueEvents([candidate()])).rejects.toBe(
          sensitive,
        );
        await expect(rejector.recordDropped([candidate()])).rejects.toBe(
          sensitive,
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "Rate rejection KV failure",
          expect.objectContaining({ failurePolicy: "retry" }),
        );
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
          "private-user",
        );
      }
    }
  });
  it.each(["allow", "retry"] as const)(
    "aggregates all KV failures once per batch with %s",
    async (onKvFailure) => {
      const config = {
        issueRateLimit: { events: 1, windowSec: 60 },
        newIssueCap: { issues: 1, windowSec: 60 },
        onKvFailure,
      };
      const { kv, logger, rejector } = setup(config);
      vi.mocked(kv.increment).mockRejectedValue(new Error("private-secret"));
      const first = rejector.batch();
      const second = rejector.batch();
      const attempts = await Promise.allSettled([
        first.rejector.admitIssueEvents([
          candidate("1", "a"),
          candidate("1", "b"),
        ]),
        first.rejector.admitNewIssues([
          candidate("1", "a"),
          candidate("2", "a"),
        ]),
        second.rejector.admitIssueEvents([candidate("1", "c")]),
      ]);
      expect(attempts.map((result) => result.status)).toEqual(
        Array(3).fill(onKvFailure === "allow" ? "fulfilled" : "rejected"),
      );
      expect(logger.warn).not.toHaveBeenCalled();
      first.flush();
      first.flush();
      second.flush();
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenNthCalledWith(
        1,
        "Rate rejection KV failure",
        {
          failures: 4,
          affected: 4,
          operations: ["issue-rate", "new-issue-cap"],
          failurePolicy: onKvFailure,
        },
      );
      expect(logger.warn).toHaveBeenNthCalledWith(
        2,
        "Rate rejection KV failure",
        {
          failures: 1,
          affected: 1,
          operations: ["issue-rate"],
          failurePolicy: onKvFailure,
        },
      );
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
        "private-secret",
      );
    },
  );
  describe("exact counting", () => {
    const counter = (kv: KV) => (key: string) => kv.get(key);
    const issueKey =
      "rate:issue:1:a:" +
      Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 60000);
    it("charges a retried event once and reuses its decision", async () => {
      const { kv, rejector } = setup({
        issueRateLimit: { events: 1, windowSec: 60 },
      });
      const first = candidate("1", "a", undefined, "same");
      const other = candidate("1", "a", undefined, "other");
      expect(await rejector.admitIssueEvents([first, other])).toEqual([
        true,
        false,
      ]);
      for (let i = 0; i < 3; i++) {
        expect(await rejector.admitIssueEvents([first])).toEqual([true]);
        expect(await rejector.admitIssueEvents([other])).toEqual([false]);
      }
      expect(await counter(kv)(issueKey)).toBe("2");
    });
    it("charges one event once when attempts run concurrently", async () => {
      const { kv, rejector } = setup({
        issueRateLimit: { events: 5, windowSec: 60 },
      });
      const same = candidate("1", "a", undefined, "same");
      const verdicts = await Promise.all([
        rejector.admitIssueEvents([same]),
        rejector.admitIssueEvents([same]),
        rejector.admitIssueEvents([same, same]),
      ]);
      expect(verdicts.flat()).toEqual([true, true, true, true]);
      expect(await counter(kv)(issueKey)).toBe("1");
    });
    it("gives duplicates inside one call the verdict of the first", async () => {
      const { kv, rejector } = setup({
        issueRateLimit: { events: 1, windowSec: 60 },
      });
      const a = candidate("1", "a", undefined, "a");
      const b = candidate("1", "a", undefined, "b");
      expect(await rejector.admitIssueEvents([a, b, b, a])).toEqual([
        true,
        false,
        false,
        true,
      ]);
      expect(await counter(kv)(issueKey)).toBe("2");
    });
    it("admits uncharged when the first attempt stored no outcome", async () => {
      const { kv, rejector } = setup({
        issueRateLimit: { events: 1, windowSec: 60 },
      });
      expect(await rejector.admitIssueEvents([candidate()])).toEqual([true]);
      const lost = candidate("1", "a", undefined, "lost");
      // The counter was charged (and the event is over the limit) but the outcome write crashed.
      vi.mocked(kv.put).mockRejectedValueOnce(new Error("crash"));
      expect(await rejector.admitIssueEvents([lost])).toEqual([false]);
      expect(await counter(kv)(issueKey)).toBe("2");
      expect(await rejector.admitIssueEvents([lost])).toEqual([true]);
      expect(await counter(kv)(issueKey)).toBe("2");
    });
    it.each(["allow", "retry"] as const)(
      "deletes the marker when the counter fails under %s, so a retry charges again",
      async (onKvFailure) => {
        const { kv, rejector } = setup({
          issueRateLimit: { events: 1, windowSec: 60 },
          onKvFailure,
        });
        const event = candidate("1", "a", undefined, "e");
        const real = vi.mocked(kv.increment).getMockImplementation();
        vi.mocked(kv.increment).mockImplementation(async (key, by, options) => {
          if (key.startsWith("rate:issue:")) throw new Error("kv down");
          return real?.(key, by, options) as Promise<number>;
        });
        const attempt = rejector.admitIssueEvents([event]);
        if (onKvFailure === "retry") await expect(attempt).rejects.toThrow();
        else expect(await attempt).toEqual([true]);
        expect(kv.delete).toHaveBeenCalledTimes(1);
        vi.mocked(kv.increment).mockImplementation(
          real as NonNullable<typeof real>,
        );
        expect(await rejector.admitIssueEvents([event])).toEqual([true]);
        expect(await counter(kv)(issueKey)).toBe("1");
      },
    );
    it("deletes markers it set when another marker fails under retry", async () => {
      const { kv, rejector } = setup({
        issueRateLimit: { events: 5, windowSec: 60 },
        onKvFailure: "retry",
      });
      const real = vi.mocked(kv.increment).getMockImplementation();
      vi.mocked(kv.increment).mockImplementation(async (key, by, options) => {
        if (key.includes(":bad:")) throw new Error("kv down");
        return real?.(key, by, options) as Promise<number>;
      });
      await expect(
        rejector.admitIssueEvents([
          candidate("1", "a", undefined, "good"),
          candidate("1", "a", undefined, "bad"),
        ]),
      ).rejects.toThrow();
      expect(
        await counter(kv)(
          "rate:charged:issue:1:good:" +
            Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 60000),
        ),
      ).toBeNull();
    });
    it("charges a candidate new issue once per window across batches and redeliveries", async () => {
      const { kv, rejector } = setup({
        newIssueCap: { issues: 1, windowSec: 60 },
      });
      const a = candidate("1", "a", undefined, "e1");
      const b = candidate("1", "b", undefined, "e2");
      expect(await rejector.admitNewIssues([a])).toEqual([true]);
      expect(await rejector.admitNewIssues([b])).toEqual([false]);
      // Redelivery and a later event of the same issue reuse the decisions.
      expect(await rejector.admitNewIssues([a])).toEqual([true]);
      expect(
        await rejector.admitNewIssues([candidate("1", "b", undefined, "e3")]),
      ).toEqual([false]);
      expect(
        await counter(kv)(
          "rate:new-issues:1:" +
            Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 60000),
        ),
      ).toBe("2");
      // The next window decides afresh.
      expect(
        await rejector.admitNewIssues([
          candidate("1", "b", "2024-01-01T00:01:00.000Z", "e4"),
        ]),
      ).toEqual([true]);
    });
    it("counts a dropped event once however often the rejection is replayed", async () => {
      const config = { issueRateLimit: { events: 1, windowSec: 60 } };
      const { kv, rejector } = setup(config);
      const dropped = candidate("1", "a", undefined, "d");
      const other = candidate("1", "a", undefined, "o");
      for (let i = 0; i < 3; i++)
        await rejector.recordDropped([dropped, dropped]);
      await Promise.all([
        rejector.recordDropped([other]),
        rejector.recordDropped([other]),
      ]);
      expect(
        await readDropped(kv, config, "1", "a", dropped.receivedAt),
      ).toEqual({ count: 2, windowSec: 60 });
    });
    it.each(["allow", "retry"] as const)(
      "deletes the dropped markers when the dropped counter fails under %s",
      async (onKvFailure) => {
        const config = {
          issueRateLimit: { events: 1, windowSec: 60 },
          onKvFailure,
        };
        const { kv, rejector } = setup(config);
        const real = vi.mocked(kv.increment).getMockImplementation();
        vi.mocked(kv.increment).mockImplementation(async (key, by, options) => {
          if (key.startsWith("rate:dropped:")) throw new Error("kv down");
          return real?.(key, by, options) as Promise<number>;
        });
        const dropped = candidate("1", "a", undefined, "d");
        const attempt = rejector.recordDropped([dropped]);
        if (onKvFailure === "retry") await expect(attempt).rejects.toThrow();
        else await attempt;
        vi.mocked(kv.increment).mockImplementation(
          real as NonNullable<typeof real>,
        );
        await rejector.recordDropped([dropped]);
        expect(
          await readDropped(kv, config, "1", "a", dropped.receivedAt),
        ).toEqual({ count: 1, windowSec: 60 });
      },
    );
  });
  it("reads only the current aligned dropped window", async () => {
    const config = { issueRateLimit: { events: 1, windowSec: 60 } };
    const { kv, rejector } = setup(config);
    await rejector.recordDropped([candidate(), candidate(), candidate("2")]);
    expect(
      await readDropped(kv, config, "1", "a", candidate().receivedAt),
    ).toEqual({ count: 2, windowSec: 60 });
    expect(
      await readDropped(
        kv,
        config,
        "1",
        "a",
        candidate("1", "a", "2024-01-01T00:01:00.000Z").receivedAt,
      ),
    ).toEqual({ count: 0, windowSec: 60 });
  });
  it("does not report corrupt counters as zero", async () => {
    const config = { issueRateLimit: { events: 1, windowSec: 60 } };
    const { kv } = setup(config);
    vi.mocked(kv.get).mockResolvedValue("not-an-integer");
    expect(
      await readDropped(kv, config, "1", "a", candidate().receivedAt),
    ).toBeNull();
  });
  it("rejects invalid limit and window bounds", () => {
    for (const events of [0, -1, 1.5, 1_000_000_001])
      expect(() =>
        setup({ issueRateLimit: { events, windowSec: 60 } }),
      ).toThrow(RangeError);
    for (const windowSec of [0, 86_401])
      expect(() => setup({ newIssueCap: { issues: 1, windowSec } })).toThrow(
        RangeError,
      );
  });
});

describe("per-project limits", () => {
  const stack = {
    issueRateLimit: { events: 10, windowSec: 60 },
    newIssueCap: { issues: 5, windowSec: 60 },
  };
  it("takes the lower of the stack and project limit and never loosens", () => {
    expect(effectiveRateLimits(stack)).toEqual({
      issueEvents: 10,
      newIssues: 5,
    });
    expect(
      effectiveRateLimits(stack, { issueEvents: 3, newIssues: 1 }),
    ).toEqual({ issueEvents: 3, newIssues: 1 });
    expect(
      effectiveRateLimits(stack, { issueEvents: 50, newIssues: 50 }),
    ).toEqual({ issueEvents: 10, newIssues: 5 });
    expect(effectiveRateLimits(stack, { issueEvents: 4 })).toEqual({
      issueEvents: 4,
      newIssues: 5,
    });
    // Corrupt stored values fall back to the stack limit.
    for (const bad of [0, -1, 1.5, Number.NaN, "3" as unknown as number])
      expect(effectiveRateLimits(stack, { issueEvents: bad })).toEqual({
        issueEvents: 10,
        newIssues: 5,
      });
  });
  it("ignores a project value for a limit the stack leaves disabled", () => {
    expect(
      effectiveRateLimits(
        { issueRateLimit: { events: 10, windowSec: 60 } },
        { issueEvents: 2, newIssues: 1 },
      ),
    ).toEqual({ issueEvents: 2 });
    expect(effectiveRateLimits({}, { issueEvents: 2 })).toEqual({});
    expect(effectiveRateLimits(undefined, { issueEvents: 2 })).toEqual({});
  });
  it("validates writes against the stack", () => {
    expect(() =>
      validateProjectRateLimits(stack, { issueEvents: 10, newIssues: 1 }),
    ).not.toThrow();
    expect(() => validateProjectRateLimits(stack, {})).not.toThrow();
    expect(() => validateProjectRateLimits(stack, { issueEvents: 11 })).toThrow(
      /exceeds the stack limit/,
    );
    expect(() => validateProjectRateLimits(stack, { newIssues: 6 })).toThrow(
      RangeError,
    );
    expect(() => validateProjectRateLimits(stack, { issueEvents: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => validateProjectRateLimits(stack, { newIssues: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      validateProjectRateLimits(
        { newIssueCap: stack.newIssueCap },
        { issueEvents: 1 },
      ),
    ).toThrow(/does not enable/);
    expect(() =>
      validateProjectRateLimits(undefined, { newIssues: 1 }),
    ).toThrow(/does not enable/);
  });
  it("enforces effective limits per project and reads each project once per batch", async () => {
    const { kv, logger } = setup(stack);
    const get = vi.fn(async (id: string) =>
      id === "1"
        ? ({
            id,
            rateLimits: { issueEvents: 1, newIssues: 1 },
          } as never)
        : ({ id } as never),
    );
    const scope = new RateRejector({
      kv,
      config: stack,
      logger,
      projects: { get },
    }).batch();
    expect(
      await scope.rejector.admitIssueEvents([
        candidate("1"),
        candidate("1"),
        candidate("2"),
        candidate("2"),
        candidate("2"),
      ]),
    ).toEqual([true, false, true, true, true]);
    expect(
      await scope.rejector.admitNewIssues([
        candidate("1", "x"),
        candidate("1", "y"),
        candidate("2", "x"),
        candidate("2", "y"),
      ]),
    ).toEqual([true, false, true, true]);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("propagates a project read failure without provider text in the KV failure log", async () => {
    const { kv, logger } = setup(stack);
    const failure = new Error("private-secret");
    const scope = new RateRejector({
      kv,
      config: stack,
      logger,
      projects: { get: async () => Promise.reject(failure) },
    }).batch();
    await expect(
      scope.rejector.admitIssueEvents([candidate("1")]),
    ).rejects.toBe(failure);
    expect(kv.increment).not.toHaveBeenCalled();
    scope.flush();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
