import { describe, expect, it } from "vitest";
import {
  assertDeletionProtectionGap,
  assertEventbridgeGap,
  assertPartialBatchGap,
  assertS3LifecycleGap,
} from "./gap-checks.mjs";

describe("emulator gaps must still reproduce", () => {
  it("fails the suite when lifecycle metadata or deletion protection is fixed", () => {
    expect(() => assertS3LifecycleGap(new Headers())).not.toThrow();
    expect(() =>
      assertS3LifecycleGap(
        new Headers({
          "x-amz-transition-default-minimum-object-size":
            "all_storage_classes_128K",
        }),
      ),
    ).toThrow();
    expect(() =>
      assertDeletionProtectionGap({ DeletionProtectionEnabled: false }, true),
    ).not.toThrow();
    expect(() =>
      assertDeletionProtectionGap({ DeletionProtectionEnabled: true }, false),
    ).toThrow();
  });
  it("fails when partial batch or target settings start being retained", () => {
    expect(() => assertPartialBatchGap({})).not.toThrow();
    expect(() =>
      assertPartialBatchGap({
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      }),
    ).toThrow();
    expect(() => assertEventbridgeGap({})).not.toThrow();
    expect(() => assertEventbridgeGap({ RetryPolicy: {} })).toThrow();
    expect(() => assertEventbridgeGap({ DeadLetterConfig: {} })).toThrow();
  });
});
