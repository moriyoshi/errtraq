import { isServed } from "@moriyoshi/errtraq-firestore-rest";
import { activeStoreContract } from "@moriyoshi/errtraq-testing";
import { describe, expect, it } from "vitest";
import { compositeIndexes, fieldExemptions } from "./indexes.js";
import { makeFakeStore, shapeOfQuery } from "./test-store.js";

const all: ReturnType<typeof makeFakeStore>["queries"] = [];
describe("Firestore store over the in-process fake", () => {
  activeStoreContract(async () => {
    const h = makeFakeStore();
    h.client.onQuery = (q) => all.push(q);
    await h.store.migrate();
    return h.store;
  });
  it("only issued queries served by declared indexes that avoid exempt fields", () => {
    expect(all.length).toBeGreaterThan(20);
    const exempt = new Set(
      fieldExemptions.map((e) => `${e.collection}.${e.field}`),
    );
    for (const q of all) {
      const shape = shapeOfQuery(q);
      expect(isServed(shape, compositeIndexes), JSON.stringify(shape)).toBe(
        true,
      );
      for (const f of [
        ...shape.equality,
        ...(shape.range ? [shape.range] : []),
        ...shape.orderBy.map((o) => o.field),
      ])
        expect(exempt.has(`${shape.collection}.${f}`)).toBe(false);
    }
  });
});
