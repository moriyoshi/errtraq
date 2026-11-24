import { describe, expect, it } from "vitest";
import { configSchema, infra, s3Blob } from "./stack.js";

const inputs = (config = {}) =>
  infra.inputs(configSchema.parse(config), {} as never);

describe("blob-s3 lifecycle configuration", () => {
  it("defaults to 30-day claim checks and 30 + 7 day overflow orphans", () => {
    expect(inputs()).toMatchObject({
      record_claim_retention_days: 30,
      max_event_retention_days: 30,
      overflow_orphan_margin_days: 7,
    });
  });
  it("passes configured ages to the module", () => {
    expect(
      inputs({
        recordClaimRetentionDays: 21,
        maxEventRetentionDays: 90,
        overflowOrphanMarginDays: 14,
      }),
    ).toMatchObject({
      record_claim_retention_days: 21,
      max_event_retention_days: 90,
      overflow_orphan_margin_days: 14,
    });
    expect(s3Blob({ maxEventRetentionDays: 90 }).config).toEqual({
      maxEventRetentionDays: 90,
    });
  });
  it.each([
    { recordClaimRetentionDays: 14 },
    { recordClaimRetentionDays: 20.5 },
    { maxEventRetentionDays: 0 },
    { overflowOrphanMarginDays: 0 },
  ])("rejects %j", (config) => {
    expect(configSchema.safeParse(config).success).toBe(false);
  });
});
