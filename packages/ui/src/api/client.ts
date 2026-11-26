import type { z } from "zod";
import { ApiError, kindOfStatus } from "./errors";
import { nextCursor } from "./link";

export interface ApiClientOptions {
  /** Origin (and optional path prefix) of the API; empty means same origin. */
  base: string;
  getToken: () => string | null;
  /** Called once for every 401 response, after the error is built. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
  /**
   * An identity-aware proxy owns the session: no Authorization header, the proxy cookie goes
   * along (same-origin only, so it never leaves this origin) and writes carry the CSRF header.
   */
  proxy?: boolean;
}

export interface RequestOptions {
  method?: "GET" | "PUT" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Token to use instead of the stored one (login validates before storing). */
  token?: string;
  /** Do not trigger `onUnauthorized` for a 401 (the login form shows the error itself). */
  quiet401?: boolean;
}

export interface Page<T> {
  items: T;
  /** Cursor of the next page; `undefined` when the listing is exhausted. */
  next: string | undefined;
}

export interface ApiClient {
  request<S extends z.ZodType>(
    path: string,
    schema: S,
    options?: RequestOptions,
  ): Promise<{ data: z.output<S>; next: string | undefined }>;
  get<S extends z.ZodType>(
    path: string,
    schema: S,
    options?: RequestOptions,
  ): Promise<z.output<S>>;
  /** A cursor-paged listing: `Link` header parsing included. */
  page<S extends z.ZodType>(
    path: string,
    schema: S,
    options?: RequestOptions,
  ): Promise<Page<z.output<S>>>;
}

/** Best-effort extraction of Sentry's `{ "detail": ... }` error body. */
async function detailOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
      if (detail && typeof detail === "object" && "message" in detail) {
        const message = (detail as { message: unknown }).message;
        if (typeof message === "string") return message;
      }
    }
  } catch {
    // not JSON; fall through
  }
  return response.statusText || `HTTP ${response.status}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.base.replace(/\/+$/, "");
  async function request<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ) {
    const url = new URL(
      `${base}${path}`,
      // A relative base is resolved against the page; tests pass an absolute one.
      typeof location === "undefined" ? "http://localhost" : location.href,
    );
    for (const [key, value] of Object.entries(opts.query ?? {}))
      if (value !== undefined && value !== "")
        url.searchParams.set(key, String(value));
    const token = options.proxy ? null : (opts.token ?? options.getToken());
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    // A cross-site form cannot set a custom header without a CORS preflight the API refuses.
    if (options.proxy && opts.method && opts.method !== "GET")
      headers["X-Errtraq-Csrf"] = "1";
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
        // Bearer tokens never need cookies; the proxy session cookie does.
        credentials: options.proxy ? "same-origin" : "omit",
      });
    } catch (cause) {
      if (opts.signal?.aborted) throw cause;
      throw new ApiError("network", "Could not reach the API");
    }
    if (!response.ok) {
      const error = new ApiError(
        kindOfStatus(response.status),
        await detailOf(response),
        response.status,
      );
      if (error.kind === "unauthorized" && !opts.quiet401)
        options.onUnauthorized?.();
      throw error;
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(
        "parse",
        "The API returned invalid JSON",
        response.status,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new ApiError(
        "parse",
        `Unexpected API response: ${parsed.error.issues[0]?.message ?? "invalid"} at ${parsed.error.issues[0]?.path.join(".") || "(root)"}`,
        response.status,
      );
    return {
      data: parsed.data as z.output<S>,
      next: nextCursor(response.headers.get("Link")),
    };
  }
  return {
    request,
    get: async (path, schema, opts) => (await request(path, schema, opts)).data,
    page: async (path, schema, opts) => {
      const { data, next } = await request(path, schema, opts);
      return { items: data, next };
    },
  };
}
