import type { ApiToken } from "@moriyoshi/errtraq-core/runtime";

/** Hono environment shared by the API route modules. */
export type ApiEnv = { Variables: { token: ApiToken } };
