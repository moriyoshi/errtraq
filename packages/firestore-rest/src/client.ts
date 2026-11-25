import {
  FirestoreAbortedError,
  FirestoreAccessDeniedError,
  FirestoreAlreadyExistsError,
  FirestoreDocumentTooLargeError,
  FirestoreError,
  FirestoreMissingIndexError,
  FirestoreNotFoundError,
  FirestorePreconditionError,
  FirestoreThrottledError,
  FirestoreUnavailableError,
} from "./errors.js";
import {
  describeRequiredIndex,
  type Query,
  type StructuredQuery,
  shapeOfStructured,
  toStructuredQuery,
} from "./query.js";
import {
  documentSize,
  type Fields,
  MAX_DOCUMENT_BYTES,
  type Value,
} from "./value.js";

/** A document read back: `path` is relative to the database documents root. */
export interface RawDocument {
  path: string;
  fields: Fields;
  createTime: string;
  updateTime: string;
}
export type Precondition = { exists: boolean } | { updateTime: string };
export interface Increment {
  field: string;
  by: number;
}
export type Write =
  | {
      kind: "set";
      path: string;
      fields: Fields;
      /** Field paths to merge; absent means replace the whole document. */
      mask?: string[];
      precondition?: Precondition;
      /** Server-side integer increments applied after the update. */
      increments?: Increment[];
    }
  | { kind: "delete"; path: string; precondition?: Precondition };
export interface CommitResult {
  writeResults: { updateTime?: string; transformResults: Value[] }[];
}

/** Operations a transaction body may use; every read is tied to the transaction. */
export interface Transaction {
  get(path: string): Promise<RawDocument | null>;
  batchGet(paths: readonly string[]): Promise<(RawDocument | null)[]>;
  runQuery(query: Query): Promise<RawDocument[]>;
  /** Commit the transaction's writes; call at most once, last. */
  commit(writes: readonly Write[]): Promise<CommitResult>;
}

/**
 * The small interface the adapters program against. The REST implementation below is one
 * implementation; a gRPC-backed client would be a drop-in replacement.
 */
export interface FirestoreClient {
  get(path: string): Promise<RawDocument | null>;
  batchGet(paths: readonly string[]): Promise<(RawDocument | null)[]>;
  runQuery(query: Query): Promise<RawDocument[]>;
  commit(writes: readonly Write[]): Promise<CommitResult>;
  runTransaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Observes every query before it is sent (index coverage tests). */
  onQuery?: (query: Query) => void;
}

export interface FirestoreRestOptions {
  projectId: string;
  /** Defaults to `(default)`. */
  databaseId?: string;
  /** Service origin; defaults to the production API. An emulator endpoint sends no credentials. */
  endpoint?: string;
  /** Returns a current OAuth2 access token; absent only against an emulator. */
  accessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  /** Bound on a whole transaction including retries. */
  transactionTimeoutMs?: number;
  maxTransactionAttempts?: number;
  /** Retries of throttled or unavailable requests. */
  maxRequestRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Uniform `[0, 1)` source for backoff jitter. */
  random?: () => number;
  /** Clock for the transaction deadline; tests inject a fake. */
  now?: () => number;
}

const PRODUCTION = "https://firestore.googleapis.com";
const MAX_BATCH_GET = 100;

function classify(
  httpStatus: number,
  status: string | undefined,
  message: string,
  ambiguous: boolean,
): FirestoreError {
  const args = [message, status, httpStatus] as const;
  if (status === "ABORTED") return new FirestoreAbortedError(...args, true);
  if (status === "ALREADY_EXISTS")
    return new FirestoreAlreadyExistsError(...args);
  if (status === "NOT_FOUND") return new FirestoreNotFoundError(...args);
  if (status === "FAILED_PRECONDITION")
    return new FirestorePreconditionError(...args);
  if (
    status === "PERMISSION_DENIED" ||
    status === "UNAUTHENTICATED" ||
    httpStatus === 401 ||
    httpStatus === 403
  )
    return new FirestoreAccessDeniedError(...args);
  if (status === "RESOURCE_EXHAUSTED" || httpStatus === 429)
    return new FirestoreThrottledError(...args, true);
  if (
    httpStatus >= 500 ||
    status === "UNAVAILABLE" ||
    status === "DEADLINE_EXCEEDED"
  )
    return new FirestoreUnavailableError(...args, true, ambiguous);
  return new FirestoreError(...args);
}

export class FirestoreRestClient implements FirestoreClient {
  onQuery?: (query: Query) => void;
  private readonly base: string;
  private readonly root: string;
  private readonly emulator: boolean;
  constructor(private readonly options: FirestoreRestOptions) {
    if (!options.projectId) throw new Error("Firestore project id is required");
    const url = new URL(options.endpoint ?? PRODUCTION);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Invalid Firestore endpoint");
    this.emulator = options.endpoint !== undefined;
    if (!this.emulator && !options.accessToken)
      throw new Error("Firestore access token source is required");
    this.root = `projects/${options.projectId}/databases/${options.databaseId ?? "(default)"}/documents`;
    this.base = `${url.origin}/v1/${this.root}`;
  }

  private url(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }
  private documentName(path: string): string {
    return `${this.root}/${path}`;
  }
  private relative(name: string): string {
    const prefix = `${this.root}/`;
    if (!name.startsWith(prefix))
      throw new FirestoreError("Unexpected document name in response");
    return name.slice(prefix.length);
  }
  private sleep(ms: number): Promise<void> {
    return (
      this.options.sleep?.(ms) ??
      new Promise((resolve) => setTimeout(resolve, ms))
    );
  }
  private backoff(attempt: number, base = 50, cap = 2000): number {
    const random = this.options.random ?? Math.random;
    return Math.floor(random() * Math.min(cap, base * 2 ** attempt));
  }

  /** One HTTP exchange with retry of throttled and (non-commit) unavailable responses. */
  private async send(
    method: "GET" | "POST",
    url: string,
    body: unknown,
    options: { retry503: boolean },
  ): Promise<unknown> {
    const retries = this.options.maxRequestRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(method, url, body);
      } catch (error) {
        const retryable =
          error instanceof FirestoreThrottledError ||
          (error instanceof FirestoreUnavailableError &&
            (options.retry503 || !error.ambiguous));
        if (!retryable || attempt >= retries) throw error;
        await this.sleep(this.backoff(attempt, 100, 4000));
      }
    }
  }
  private async sendOnce(
    method: "GET" | "POST",
    url: string,
    body: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.options.accessToken) {
      headers.authorization = `Bearer ${await this.options.accessToken()}`;
    } else headers.authorization = "Bearer owner";
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? 30000,
    );
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new FirestoreUnavailableError(
        controller.signal.aborted
          ? "Firestore request timed out"
          : "Firestore request failed",
        controller.signal.aborted ? "DEADLINE_EXCEEDED" : undefined,
        undefined,
        true,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      if (response.ok) throw new FirestoreError("Invalid Firestore response");
    }
    if (!response.ok) {
      const error = (
        parsed as { error?: { status?: string; message?: string } } | undefined
      )?.error;
      // Provider messages can quote document names but never request bodies.
      throw classify(
        response.status,
        error?.status,
        `Firestore request failed: ${error?.status ?? response.status}`,
        response.status >= 500,
      );
    }
    return parsed;
  }

  private doc(raw: {
    name: string;
    fields?: Fields;
    createTime: string;
    updateTime: string;
  }): RawDocument {
    return {
      path: this.relative(raw.name),
      fields: raw.fields ?? {},
      createTime: raw.createTime,
      updateTime: raw.updateTime,
    };
  }

  async get(path: string, transaction?: string): Promise<RawDocument | null> {
    const suffix = transaction
      ? `?transaction=${encodeURIComponent(transaction)}`
      : "";
    try {
      const raw = await this.send(
        "GET",
        `${this.base}/${this.url(path)}${suffix}`,
        undefined,
        {
          retry503: true,
        },
      );
      return this.doc(raw as Parameters<FirestoreRestClient["doc"]>[0]);
    } catch (error) {
      if (error instanceof FirestoreNotFoundError) return null;
      throw error;
    }
  }

  async batchGet(
    paths: readonly string[],
    transaction?: string,
  ): Promise<(RawDocument | null)[]> {
    const found = new Map<string, RawDocument>();
    for (let i = 0; i < paths.length; i += MAX_BATCH_GET) {
      const chunk = paths.slice(i, i + MAX_BATCH_GET);
      const response = (await this.send(
        "POST",
        `${this.base}:batchGet`,
        {
          documents: chunk.map((p) => this.documentName(p)),
          ...(transaction ? { transaction } : {}),
        },
        { retry503: true },
      )) as { found?: Parameters<FirestoreRestClient["doc"]>[0] }[];
      for (const entry of response)
        if (entry.found) {
          const doc = this.doc(entry.found);
          found.set(doc.path, doc);
        }
    }
    return paths.map((p) => found.get(p) ?? null);
  }

  async runQuery(query: Query, transaction?: string): Promise<RawDocument[]> {
    this.onQuery?.(query);
    const structured = toStructuredQuery(query, (p) => this.documentName(p));
    const parent = query.parent
      ? `${this.base}/${this.url(query.parent)}`
      : this.base;
    let response: { document?: Parameters<FirestoreRestClient["doc"]>[0] }[];
    try {
      response = (await this.send(
        "POST",
        `${parent}:runQuery`,
        {
          structuredQuery: structured,
          ...(transaction ? { transaction } : {}),
        },
        { retry503: true },
      )) as typeof response;
    } catch (error) {
      if (
        error instanceof FirestorePreconditionError &&
        error.status === "FAILED_PRECONDITION"
      )
        throw new FirestoreMissingIndexError(
          query.collection,
          describeRequiredIndex(
            shapeOfStructured(structured as StructuredQuery),
          ),
        );
      throw error;
    }
    return response.flatMap((entry) =>
      entry.document ? [this.doc(entry.document)] : [],
    );
  }

  async commit(
    writes: readonly Write[],
    transaction?: string,
  ): Promise<CommitResult> {
    const wire = writes.map((w) => {
      const precondition =
        w.precondition === undefined ? {} : { currentDocument: w.precondition };
      if (w.kind === "delete")
        return { delete: this.documentName(w.path), ...precondition };
      const size = documentSize(w.path, w.fields);
      if (size > MAX_DOCUMENT_BYTES)
        throw new FirestoreDocumentTooLargeError(
          `Firestore document ${w.path.split("/").slice(0, -1).join("/")}/* exceeds 1 MiB (${size} bytes)`,
        );
      return {
        update: { name: this.documentName(w.path), fields: w.fields },
        ...(w.mask ? { updateMask: { fieldPaths: w.mask } } : {}),
        ...(w.increments?.length
          ? {
              updateTransforms: w.increments.map((i) => ({
                fieldPath: i.field,
                increment: { integerValue: String(i.by) },
              })),
            }
          : {}),
        ...precondition,
      };
    });
    const response = (await this.send(
      "POST",
      `${this.base}:commit`,
      { writes: wire, ...(transaction ? { transaction } : {}) },
      { retry503: false },
    )) as {
      writeResults?: { updateTime?: string; transformResults?: Value[] }[];
    };
    return {
      writeResults: (response.writeResults ?? []).map((r) => ({
        ...(r.updateTime ? { updateTime: r.updateTime } : {}),
        transformResults: r.transformResults ?? [],
      })),
    };
  }

  private async begin(): Promise<string> {
    const response = (await this.send(
      "POST",
      `${this.base}:beginTransaction`,
      { options: { readWrite: {} } },
      { retry503: true },
    )) as { transaction?: string };
    if (!response.transaction)
      throw new FirestoreError("Invalid Firestore transaction response");
    return response.transaction;
  }
  private async rollback(transaction: string): Promise<void> {
    try {
      await this.send(
        "POST",
        `${this.base}:rollback`,
        { transaction },
        { retry503: false },
      );
    } catch {
      // Best effort: the server expires an idle transaction.
    }
  }

  /**
   * Runs `body` in a read-write transaction, retrying the whole body on `ABORTED` with jittered
   * exponential backoff until the attempt or time budget is spent.
   */
  async runTransaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    const attempts = this.options.maxTransactionAttempts ?? 12;
    const clock = this.options.now ?? Date.now;
    const deadline = clock() + (this.options.transactionTimeoutMs ?? 60000);
    for (let attempt = 0; ; attempt++) {
      let id: string | undefined;
      let committed = false;
      try {
        const transaction = await this.begin();
        id = transaction;
        const tx: Transaction = {
          get: (path) => this.get(path, transaction),
          batchGet: (paths) => this.batchGet(paths, transaction),
          runQuery: (query) => this.runQuery(query, transaction),
          commit: async (writes) => {
            committed = true;
            return this.commit(writes, transaction);
          },
        };
        const result = await body(tx);
        if (!committed) await this.rollback(transaction);
        return result;
      } catch (error) {
        if (id && !committed) await this.rollback(id);
        if (
          !(error instanceof FirestoreAbortedError) ||
          attempt + 1 >= attempts ||
          clock() >= deadline
        )
          throw error;
        await this.sleep(this.backoff(attempt, 25, 1500));
      }
    }
  }
}
