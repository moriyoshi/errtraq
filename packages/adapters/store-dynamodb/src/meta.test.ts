import type { ArchiveState, ProjectId } from "@errtraq/core";
import { VersionConflictError } from "@errtraq/core/store";
import { expect, it, vi } from "vitest";
import { DynamoStoreError } from "./errors.js";
import { metaRepository } from "./meta.js";

it("uses a conditional PutItem and reports only definite condition failures as conflicts", async () => {
  const project = "project" as ProjectId;
  const state = { projectId: project, version: 0 } as ArchiveState;
  const request = vi.fn(async () => ({}));
  const repo = metaRepository({ table: "table", request });
  await repo.compareAndSetArchiveState(project, null, state);
  expect(request).toHaveBeenCalledWith(
    "PutItem",
    expect.objectContaining({
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  request.mockRejectedValueOnce(
    new DynamoStoreError("failed", "ConditionalCheckFailedException"),
  );
  await expect(
    repo.compareAndSetArchiveState(project, null, state),
  ).rejects.toBeInstanceOf(VersionConflictError);
  const ambiguous = new DynamoStoreError(
    "failed",
    "ConditionalCheckFailedException",
    false,
    true,
  );
  request.mockRejectedValueOnce(ambiguous);
  await expect(
    repo.compareAndSetArchiveState(project, null, state),
  ).rejects.toBe(ambiguous);
});
