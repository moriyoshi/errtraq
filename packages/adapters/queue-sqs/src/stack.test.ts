import { describe, expect, it } from "vitest";
import { sqsQueue } from "./stack.js";

describe("sqsQueue archive.project settings", () => {
  it("gives the per-topic archive queue its own visibility, batch size and concurrency", () => {
    const { infra } = sqsQueue({ mode: "per-topic" });
    expect(infra.topics?.routes["archive.project"].physical).toBe(
      "archive_project",
    );
    expect(infra.topics?.settings?.archive_project).toEqual({
      visibilityTimeoutSec: 1800,
      batchSize: 1,
      maxConcurrency: 5,
      dlq: { enabled: true, maxReceiveCount: 5 },
    });
    expect(infra.topics?.settings?.ingest).toMatchObject({
      visibilityTimeoutSec: 180,
      batchSize: 10,
    });
  });
  it("applies the archive overrides and leaves the shared mode untouched", () => {
    const tuned = sqsQueue({
      mode: "per-topic",
      archiveVisibilityTimeoutSec: 600,
      archiveMaxConcurrency: 2,
    });
    expect(tuned.infra.topics?.settings?.archive_project).toMatchObject({
      visibilityTimeoutSec: 600,
      maxConcurrency: 2,
    });
    const shared = sqsQueue({});
    expect(shared.infra.topics?.settings?.shared).toMatchObject({
      visibilityTimeoutSec: 180,
      batchSize: 10,
    });
  });
});
