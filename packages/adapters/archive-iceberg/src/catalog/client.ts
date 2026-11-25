import { type CatalogAuth, RequestAuthenticator } from "./auth.js";
import {
  CatalogAlreadyExistsError,
  CatalogAuthError,
  CatalogCommitConflictError,
  CatalogCommitStateUnknownError,
  type CatalogError,
  type CatalogErrorBody,
  CatalogNotFoundError,
  CatalogProtocolError,
  CatalogRequestError,
  CatalogTransientError,
} from "./errors.js";
import { Long, parseJsonPreservingLongs, stringifyWithLongs } from "./json.js";
import type {
  CatalogConfig,
  CommitTableRequest,
  CommitTableResult,
  CreateTableRequest,
  LoadTableResult,
  LongId,
  Namespace,
  Properties,
  TableRequirement,
  TableUpdate,
} from "./types.js";

export interface IcebergRestCatalogOptions {
  /** The catalog base URI, for example `http://host:8181/catalog` or the S3 Tables `/iceberg` URL. */
  uri: string;
  /** Sent as the `warehouse` query parameter of `GET /v1/config` (an ARN on S3 Tables). */
  warehouse?: string;
  auth?: CatalogAuth;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  /**
   * Keep calling `uri` even when the server advertises a different `uri` in its config. Lakekeeper
   * builds the advertised URI from the Host header, which breaks behind a proxy. Default false (spec).
   */
  ignoreServerUri?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** ASCII unit separator, the REST spec's multi-level namespace delimiter. */
const NAMESPACE_SEPARATOR = "\u001f";

export function encodeNamespace(namespace: Namespace): string {
  if (namespace.length === 0)
    throw new TypeError("Namespace must not be empty");
  return namespace
    .map((part) => {
      if (!part || part.includes(NAMESPACE_SEPARATOR))
        throw new TypeError("Invalid namespace part");
      return part;
    })
    .join(NAMESPACE_SEPARATOR);
}

function isErrorBody(value: unknown): value is { error: CatalogErrorBody } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "object" &&
    (value as { error?: unknown }).error !== null
  );
}

interface Call {
  operation: string;
  method: "GET" | "POST" | "HEAD";
  /** Path below the prefix-qualified base, already encoded. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Config requests are issued before a prefix is known. */
  raw?: boolean;
  isCommit?: boolean;
  headers?: Record<string, string>;
}

/**
 * A minimal Iceberg REST catalog client: the calls errtraq itself needs (the DuckDB engine talks
 * to the catalog on its own). Only Web-standard APIs, so it bundles for Workers.
 */
export class IcebergRestCatalog {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authenticator: RequestAuthenticator;
  private readonly timeoutMs: number;
  private configPromise: Promise<CatalogConfig> | undefined;
  private resolvedBase: string | undefined;
  private resolvedPrefix: string | undefined;

  constructor(private readonly options: IcebergRestCatalogOptions) {
    this.base = options.uri.replace(/\/+$/, "");
    // Capture the global fetch lazily-bound so it keeps its receiver.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authenticator = new RequestAuthenticator(
      options.auth ?? { type: "none" },
      {
        fetch: this.fetchImpl,
        now: options.now ?? Date.now,
        baseUri: this.base,
        timeoutMs: this.timeoutMs,
      },
    );
  }

  /**
   * `GET /v1/config?warehouse=...`. The result is cached for the life of the client. Server
   * `overrides` win over `defaults`; the effective `prefix` (and `uri`, when overridden) apply
   * to every later call.
   */
  getConfig(): Promise<CatalogConfig> {
    this.configPromise ??= this.loadConfig().catch((error: unknown) => {
      this.configPromise = undefined;
      throw error;
    });
    return this.configPromise;
  }

  /** The effective properties: `defaults` overlaid by `overrides`. */
  async properties(): Promise<Properties> {
    const config = await this.getConfig();
    return { ...config.defaults, ...config.overrides };
  }

  /** The path prefix the server assigned (as sent, already URL-encoded), if any. */
  async prefix(): Promise<string | undefined> {
    await this.getConfig();
    return this.resolvedPrefix;
  }

  async createNamespace(
    namespace: Namespace,
    properties: Properties = {},
    options: { ifNotExists?: boolean } = {},
  ): Promise<{ created: boolean }> {
    try {
      await this.call({
        operation: "createNamespace",
        method: "POST",
        path: "/namespaces",
        body: { namespace: [...namespace], properties },
      });
      return { created: true };
    } catch (error) {
      if (options.ifNotExists && error instanceof CatalogAlreadyExistsError)
        return { created: false };
      throw error;
    }
  }

  /**
   * `POST .../namespaces/{ns}/tables`. `accessDelegation` is sent as `X-Iceberg-Access-Delegation`
   * only when given; errtraq's local setups pass none (static credentials).
   */
  async createTable(
    namespace: Namespace,
    request: CreateTableRequest,
    options: { accessDelegation?: string } = {},
  ): Promise<LoadTableResult> {
    return (await this.call({
      operation: "createTable",
      method: "POST",
      path: `/namespaces/${encodeURIComponent(encodeNamespace(namespace))}/tables`,
      body: request,
      headers: accessDelegationHeader(options.accessDelegation),
    })) as LoadTableResult;
  }

  /** `GET .../tables/{table}`. Throws `CatalogNotFoundError` when the table does not exist. */
  async loadTable(
    namespace: Namespace,
    table: string,
    options: { accessDelegation?: string; snapshots?: "all" | "refs" } = {},
  ): Promise<LoadTableResult> {
    return (await this.call({
      operation: "loadTable",
      method: "GET",
      path: tablePath(namespace, table),
      query: { snapshots: options.snapshots },
      headers: accessDelegationHeader(options.accessDelegation),
    })) as LoadTableResult;
  }

  /**
   * `POST .../tables/{table}` with requirements and updates. A 409 raises the retryable
   * `CatalogCommitConflictError`; a 5xx raises `CatalogCommitStateUnknownError` (not blindly
   * retryable).
   */
  async commit(
    namespace: Namespace,
    table: string,
    request: CommitTableRequest,
  ): Promise<CommitTableResult> {
    return (await this.call({
      operation: "commit",
      method: "POST",
      path: tablePath(namespace, table),
      body: {
        identifier: { namespace: [...namespace], name: table },
        requirements: request.requirements.map(wireRequirement),
        updates: request.updates.map(wireUpdate),
      },
      isCommit: true,
    })) as CommitTableResult;
  }

  private async loadConfig(): Promise<CatalogConfig> {
    const raw = (await this.call({
      operation: "getConfig",
      method: "GET",
      path: "/v1/config",
      query: { warehouse: this.options.warehouse },
      raw: true,
    })) as Partial<CatalogConfig> | null;
    if (!raw || typeof raw !== "object")
      throw new CatalogProtocolError(
        { operation: "getConfig", status: 200 },
        "Iceberg catalog config response is not an object",
      );
    const config: CatalogConfig = {
      defaults: raw.defaults ?? {},
      overrides: raw.overrides ?? {},
      ...(raw.endpoints ? { endpoints: raw.endpoints } : {}),
    };
    const effective = { ...config.defaults, ...config.overrides };
    // An overridden `uri` replaces the base for later calls (spec: catalog config properties).
    this.resolvedBase = (
      (this.options.ignoreServerUri ? undefined : effective.uri) ?? this.base
    ).replace(/\/+$/, "");
    // The prefix is a server-supplied path segment, already encoded as the server wants it.
    this.resolvedPrefix = effective.prefix
      ? effective.prefix.replace(/^\/+|\/+$/g, "")
      : undefined;
    this.authenticator.setDiscoveredTokenEndpoint(
      effective["oauth2-server-uri"],
    );
    return config;
  }

  private async url(call: Call): Promise<string> {
    let root: string;
    let path = call.path;
    if (call.raw) {
      root = this.base;
    } else {
      await this.getConfig();
      root = this.resolvedBase ?? this.base;
      path = `/v1${this.resolvedPrefix ? `/${this.resolvedPrefix}` : ""}${path}`;
    }
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(call.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, value);
    return url.toString();
  }

  private async call(call: Call): Promise<unknown> {
    const url = await this.url(call);
    const body =
      call.body === undefined ? undefined : stringifyWithLongs(call.body);
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers({
        accept: "application/json",
        ...call.headers,
      });
      if (body !== undefined) headers.set("content-type", "application/json");
      const signed = await this.authenticator.authenticate({
        method: call.method,
        url,
        headers,
        body,
      });
      let response: Response;
      try {
        response = await this.fetchImpl(signed.url, {
          method: call.method,
          headers: signed.headers,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (call.isCommit)
          throw new CatalogCommitStateUnknownError(
            { operation: call.operation, status: 0 },
            `Iceberg catalog ${call.operation} did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        throw new CatalogTransientError(
          { operation: call.operation, status: 0 },
          `Iceberg catalog ${call.operation} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const text = await response.text();
      if (
        response.status === 401 &&
        attempt === 0 &&
        this.authenticator.refreshable
      ) {
        // The cached token may have been revoked early; fetch a fresh one once.
        this.authenticator.invalidate();
        continue;
      }
      if (!response.ok) throw mapError(call, response.status, text);
      if (!text) return null;
      try {
        return parseJsonPreservingLongs(text);
      } catch {
        throw new CatalogProtocolError(
          {
            operation: call.operation,
            status: response.status,
            rawBody: text.slice(0, 512),
          },
          `Iceberg catalog ${call.operation} returned invalid JSON`,
        );
      }
    }
  }
}

function accessDelegationHeader(
  value: string | undefined,
): Record<string, string> | undefined {
  return value ? { "x-iceberg-access-delegation": value } : undefined;
}

function tablePath(namespace: Namespace, table: string): string {
  if (!table) throw new TypeError("Table name must not be empty");
  return `/namespaces/${encodeURIComponent(encodeNamespace(namespace))}/tables/${encodeURIComponent(table)}`;
}

function wireRequirement(requirement: TableRequirement): unknown {
  if (requirement.type === "assert-ref-snapshot-id")
    return {
      ...requirement,
      "snapshot-id":
        requirement["snapshot-id"] === null
          ? null
          : new Long(requirement["snapshot-id"]),
    };
  return requirement;
}

function wireUpdate(update: TableUpdate): unknown {
  switch (update.action) {
    case "remove-snapshots":
      return {
        ...update,
        "snapshot-ids": update["snapshot-ids"].map(
          (id: LongId) => new Long(id),
        ),
      };
    case "set-snapshot-ref":
      return { ...update, "snapshot-id": new Long(update["snapshot-id"]) };
    case "set-properties":
      return update;
  }
}

function mapError(call: Call, status: number, text: string): CatalogError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const init = {
    operation: call.operation,
    status,
    ...(isErrorBody(parsed)
      ? { body: parsed.error }
      : { rawBody: text.slice(0, 512) }),
  };
  if (status === 401 || status === 403) return new CatalogAuthError(init);
  if (status === 404) return new CatalogNotFoundError(init);
  if (status === 409)
    return call.isCommit
      ? new CatalogCommitConflictError(init)
      : new CatalogAlreadyExistsError(init);
  if (
    call.isCommit &&
    (status === 500 || status === 502 || status === 503 || status === 504)
  )
    return new CatalogCommitStateUnknownError(init);
  if (status === 429 || status === 502 || status === 503 || status === 504)
    return new CatalogTransientError(init);
  return new CatalogRequestError(init);
}
