import type { CreateContext } from "@errtraq/core";
/** Runtime adapter is intentionally deferred to M3. */
export function create(_context: CreateContext): never {
  throw new Error("store-dynamodb runtime not implemented until M3");
}
