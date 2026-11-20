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
