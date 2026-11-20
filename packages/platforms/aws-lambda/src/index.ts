import type { CreateContext } from "@errtraq/core";

export { infra, manifest } from "./stack.js";
/** Runtime adapter is intentionally deferred to M3. */
export function create(_context: CreateContext): never {
  throw new Error("platform-aws-lambda runtime not implemented until M3");
}
