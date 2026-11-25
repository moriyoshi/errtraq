import type {
  Day,
  EventId,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import {
  FaultInjector,
  faultyActiveStore,
  faultyArchiveStore,
  faultyBlobStore,
  faultyMeta,
  InjectedFault,
} from "./faults.js";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryArchiveStore, MemoryBlobStore } from "./memory-other.js";

const project = "1" as ProjectId;
const row = (id: string): StoredEvent => ({
  projectId: project,
  eventId: id as EventId,
  issueId: "i" as StoredEvent["issueId"],
  timestamp: "2024-01-01T00:00:00.000Z" as Timestamp,
  receivedAt: "2024-01-01T00:00:00.000Z" as Timestamp,
  level: "error",
  tags: {},
  payload: {},
});
const batch = {
  batchId: "1/1",
  rows: [row("a")],
  dayRange: ["2024-01-01", "2024-01-01"] as [Day, Day],
};

describe("fault injection wrappers", () => {
  it("throws before the effect on the Nth call of an archive operation", async () => {
    const inner = new MemoryArchiveStore();
    const faults = new FaultInjector().arm({
      op: "archive.append",
      nth: 2,
      when: "before",
    });
    const archive = faultyArchiveStore(inner, faults);
    expect(archive.capabilities.rowDelete).toBe("deletion-vector");
    await archive.hasBatch("x", batch.dayRange);
    await archive.append(batch);
    await expect(archive.append(batch)).rejects.toBeInstanceOf(InjectedFault);
    expect(faults.count("archive.append")).toBe(2);
    expect(faults.count("archive.hasBatch")).toBe(1);
    // fires once
    await expect(archive.append(batch)).resolves.toMatchObject({ rowCount: 1 });
  });

  it("leaves the effect in place when failing after", async () => {
    const inner = new MemoryArchiveStore();
    const faults = new FaultInjector().arm({
      op: "archive.append",
      nth: 1,
      when: "after",
    });
    const archive = faultyArchiveStore(inner, faults);
    await expect(archive.append(batch)).rejects.toMatchObject({
      name: "InjectedFault",
      plan: { when: "after" },
    });
    expect(await inner.hasBatch("1/1", batch.dayRange)).toBe(true);
    expect(faults.fired).toHaveLength(1);
  });

  it("wraps nested active-store repos and meta, sharing counts through one injector", async () => {
    const active = new MemoryActiveStore();
    const faults = new FaultInjector()
      .arm({ op: "events.deleteBatch", nth: 1, when: "after" })
      .arm({ op: "meta.compareAndSetArchiveState", nth: 1, when: "before" });
    const store = faultyActiveStore(active, faults);
    await expect(
      store.events.deleteBatch(project, ["a" as EventId]),
    ).rejects.toBeInstanceOf(InjectedFault);
    await store.events.deleteBatch(project, ["a" as EventId]);
    expect(faults.count("events.deleteBatch")).toBe(2);
    const meta = faultyMeta(active.meta, faults);
    const state = {
      projectId: project,
      version: 0,
      archivedThrough: "1970-01-01T00:00:00.000Z" as Timestamp,
      seq: 0,
    };
    await expect(
      meta.compareAndSetArchiveState(project, null, state),
    ).rejects.toBeInstanceOf(InjectedFault);
    expect(await meta.getArchiveState(project)).toBeNull();
    await meta.compareAndSetArchiveState(project, null, state);
    expect(await meta.getArchiveState(project)).toMatchObject({ seq: 0 });
  });

  it("wraps blob stores, resets and validates plans", async () => {
    const inner = new MemoryBlobStore();
    const faults = new FaultInjector();
    const blobs = faultyBlobStore(inner, faults);
    faults.arm({ op: "blob.put", nth: 1, when: "before" });
    await expect(blobs.put("k", new Uint8Array([1]))).rejects.toBeInstanceOf(
      InjectedFault,
    );
    expect(await inner.head("k")).toBeNull();
    faults.reset();
    expect(faults.calls()).toEqual({});
    faults.arm({ op: "blob.delete", nth: 1, when: "before" }).disarm();
    await blobs.delete("k");
    expect(() => faults.arm({ op: "x", nth: 0, when: "after" })).toThrow(
      RangeError,
    );
  });
});
