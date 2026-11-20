import { FakeClock, kvContract } from "@errtraq/testing";
import { expect, it } from "vitest";
import { create } from "./index.js";

const clock = new FakeClock();
kvContract(() => create({}, { clock }), {
  clock,
  advance: (ms) => clock.advance(ms),
});
it("sets increment TTL only when creating a counter", async () => {
  const kv = create({}, { clock });
  await kv.increment("count", 1, { ttlSec: 10 });
  clock.advance(5000);
  await kv.increment("count", 1, { ttlSec: 30 });
  clock.advance(5000);
  expect(await kv.get("count")).toBeNull();
});

it("sweeps expired entries during later activity", async () => {
  const clock = new FakeClock();
  const kv = create({}, { clock });
  for (let i = 0; i < 100; i++) await kv.put(`k${i}`, "v", { ttlSec: 1 });
  clock.advance(1000);
  for (let i = 0; i < 64; i++) await kv.get("other");
  expect((kv as unknown as { rows: Map<string, unknown> }).rows.size).toBe(0);
});
