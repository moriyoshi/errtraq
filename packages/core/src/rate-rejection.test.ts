import { describe, expect, it, vi } from "vitest";
import type { ProjectId, Timestamp } from "./domain.js";
import type { KV, Logger } from "./ports.js";
import { RateRejector, readDropped } from "./rate-rejection.js";

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
const candidate = (
  projectId = "1",
  issueId = "a",
  at = "2024-01-01T00:00:00.000Z",
) => ({
  projectId: projectId as ProjectId,
  issueId,
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
    expect(kv.increment).toHaveBeenCalledTimes(2);
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
