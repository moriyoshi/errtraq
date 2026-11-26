import { describe, expect, it } from "vitest";
import { bulkQuery, chunk, runBatches, summarize, withoutIssues } from "./bulk";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);

describe("bulk batching", () => {
  it("splits at 100 ids", () => {
    expect(chunk(ids(250), 100).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(chunk([], 100)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it("sends each batch once, in order, with duplicates removed", async () => {
    const sent: string[][] = [];
    const results = await runBatches([...ids(120), "i0"], async (b) => {
      sent.push(b);
    });
    expect(sent.map((b) => b.length)).toEqual([100, 20]);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(summarize(results)).toEqual({
      updated: ids(120),
      failed: [],
      message: "",
    });
  });

  it("reports a partial failure per batch and still tries the rest", async () => {
    const calls: number[] = [];
    const results = await runBatches(ids(250), async (b) => {
      calls.push(b.length);
      if (b[0] === "i100") throw new Error("Not found");
    });
    expect(calls).toEqual([100, 100, 50]);
    expect(results.map((r) => r.error)).toEqual([
      undefined,
      "Not found",
      undefined,
    ]);
    const summary = summarize(results);
    expect(summary.updated).toHaveLength(150);
    expect(summary.failed).toEqual(ids(200).slice(100));
    expect(summary.message).toBe(
      "Updated 150 of 250 issues; 100 failed: Not found",
    );
  });

  it("names a non-Error rejection generically", async () => {
    const results = await runBatches(["a"], () => Promise.reject("x"));
    expect(results).toEqual([{ ids: ["a"], error: "Request failed" }]);
  });

  it("builds repeated, encoded id parameters", () => {
    expect(bulkQuery(["1", "a b", "c&d"])).toBe("id=1&id=a%20b&id=c%26d");
  });
});

describe("withoutIssues", () => {
  it("removes issues from every page and keeps the paging fields", () => {
    const data = {
      pageParams: ["", "c1"],
      pages: [
        { items: [{ id: "a" }, { id: "b" }], next: "c1" },
        { items: [{ id: "c" }], next: undefined },
      ],
    };
    const out = withoutIssues(data, new Set(["b", "c"]));
    expect(out.pages.map((p) => p.items.map((i) => i.id))).toEqual([["a"], []]);
    expect(out.pages[0]?.next).toBe("c1");
    expect(out.pageParams).toEqual(["", "c1"]);
    // The input is not mutated (the snapshot used for rollback stays intact).
    expect(data.pages[0]?.items).toHaveLength(2);
  });
});
