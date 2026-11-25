import type { CreateContext } from "@moriyoshi/errtraq-core";

export { infra, manifest } from "./stack.js";
/** The platform has no runtime adapter: the generated entrypoint composes the handler directly. */
export function create(_context: CreateContext): never {
  throw new Error("platform-cloud-run has no runtime adapter");
}
