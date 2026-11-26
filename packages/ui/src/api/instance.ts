import { handleUnauthorized, peekToken } from "../auth/session";
import { createApiClient } from "./client";

/**
 * `VITE_ERRTRAQ_API_BASE` is a build-time origin for deployments where the UI and the API are
 * on different origins (the API then needs CORS). Empty means same origin: `/api/0/...`.
 */
export const apiBase: string = import.meta.env.VITE_ERRTRAQ_API_BASE ?? "";

export const api = createApiClient({
  base: apiBase,
  getToken: peekToken,
  onUnauthorized: handleUnauthorized,
});
