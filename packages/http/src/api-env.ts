import type { Principal } from "./auth.js";

/**
 * Hono environment shared by the API route modules. `token` keeps its historical name; it holds
 * the request's principal (an API token, an OIDC identity or a proxy identity), of which routes
 * read only `orgId` and `scopes`.
 */
export type ApiEnv = { Variables: { token: Principal } };
