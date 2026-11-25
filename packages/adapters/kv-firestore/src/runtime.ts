import type { Clock, CreateContext, KV } from "@moriyoshi/errtraq-core";
import {
  InvalidCounterError,
  KVAccessDeniedError,
  KVError,
  KVInvalidKeyError,
  KVThrottledError,
  KVUnavailableError,
} from "@moriyoshi/errtraq-core/kv";
import {
  encodeFields,
  FirestoreAbortedError,
  FirestoreAccessDeniedError,
  FirestoreAlreadyExistsError,
  type FirestoreClient,
  FirestoreError,
  FirestoreNotFoundError,
  FirestorePreconditionError,
  FirestoreRestClient,
  FirestoreThrottledError,
  FirestoreUnavailableError,
  FsTimestamp,
  type RawDocument,
} from "@moriyoshi/errtraq-firestore-rest";
import {
  type Config,
  DATABASE_BINDING,
  TTL_COLLECTION,
  TTL_FIELD,
} from "./stack.js";

const decimal = (value: string): boolean =>
  /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
const MAX_ATTEMPTS = 64;

/**
 * Document `kv/{key}`: `v` (the string value), `n` (integer, present when the value is a
 * decimal safe integer), `c` (true once an increment owns the value, then `n` is
 * authoritative) and `expireAt` (timestamp with a TTL policy). Firestore deletes expired
 * documents up to a day late, so every read compares `expireAt` to the clock.
 *
 * Hot keys: Firestore sustains roughly one sustained write per second per document (an
 * operating assumption, not a documented limit). `increment` is a commit field transform, so
 * concurrent increments of a live counter do not read-modify-write, but they still queue on the
 * one document; sustained rates well above that see latency and failures, which core's
 * `onKvFailure: "allow"` turns into fail-open. Window-key the counters, and prefer a Redis KV
 * if the DSN-key limiter contends (GCP_PLAN D5).
 */
export interface FirestoreKVOptions {
  client: FirestoreClient;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
export class FirestoreKV implements KV {
  constructor(private readonly options: FirestoreKVOptions) {}
  private now(): number {
    const time = this.options.clock
      ? Date.parse(this.options.clock.now())
      : Date.now();
    if (!Number.isFinite(time)) throw new Error("Invalid KV clock");
    return time;
  }
  private path(key: string): string {
    if (typeof key !== "string" || key.length === 0)
      throw new KVInvalidKeyError("Invalid Firestore KV key");
    const bytes = new TextEncoder().encode(key);
    if (new TextDecoder().decode(bytes) !== key)
      throw new KVInvalidKeyError("Invalid Firestore KV key");
    let encoded = "";
    for (const byte of bytes) {
      const char = String.fromCharCode(byte);
      encoded += /[A-Za-z0-9_:@=+,-]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    // Firestore forbids ids starting and ending with `__`; `.` never appears unescaped.
    if (encoded.startsWith("__")) encoded = `%5F${encoded.slice(1)}`;
    if (encoded.length > 1500)
      throw new KVInvalidKeyError("Firestore KV key is too long");
    return `${TTL_COLLECTION}/${encoded}`;
  }
  private expiry(ttlSec?: number): number | undefined {
    if (ttlSec === undefined) return undefined;
    if (!Number.isFinite(ttlSec) || ttlSec < 0)
      throw new RangeError("Invalid KV TTL");
    const ms = Math.ceil(this.now() + ttlSec * 1000);
    if (!Number.isSafeInteger(ms)) throw new RangeError("Invalid KV TTL");
    return ms;
  }
  private expired(doc: RawDocument): boolean {
    const at = doc.fields[TTL_FIELD];
    return (
      at !== undefined &&
      "timestampValue" in at &&
      Date.parse(at.timestampValue) <= this.now()
    );
  }
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof FirestoreError)) throw error;
      const args = [error.message, error.status, error.ambiguous] as const;
      let mapped: KVError;
      if (error instanceof FirestoreAccessDeniedError)
        mapped = new KVAccessDeniedError(...args);
      else if (error instanceof FirestoreThrottledError)
        mapped = new KVThrottledError(...args);
      else if (
        error instanceof FirestoreUnavailableError ||
        error instanceof FirestoreAbortedError
      )
        mapped = new KVUnavailableError(...args);
      else mapped = new KVError(...args);
      Object.defineProperty(mapped, "cause", { value: error });
      throw mapped;
    }
  }
  private sleep(attempt: number): Promise<void> {
    const delay = Math.floor(
      (this.options.random ?? Math.random)() * Math.min(500, 5 * 2 ** attempt),
    );
    return (
      this.options.sleep?.(delay) ?? new Promise((r) => setTimeout(r, delay))
    );
  }

  async get(key: string): Promise<string | null> {
    const path = this.path(key);
    return this.guard(async () => {
      const doc = await this.options.client.get(path);
      if (!doc || this.expired(doc)) return null;
      const value = doc.fields.v;
      const n = doc.fields.n;
      const counter = doc.fields.c;
      if (
        counter &&
        "booleanValue" in counter &&
        counter.booleanValue &&
        n &&
        "integerValue" in n
      )
        return String(Number(n.integerValue));
      if (!value || !("stringValue" in value))
        throw new KVError("Invalid Firestore KV document");
      return value.stringValue;
    });
  }

  async put(
    key: string,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<void> {
    const path = this.path(key);
    const expiry = this.expiry(options?.ttlSec);
    if (typeof value !== "string")
      throw new TypeError("KV value must be a string");
    await this.guard(() =>
      this.options.client.commit([
        {
          kind: "set",
          path,
          fields: encodeFields({
            v: value,
            ...(decimal(value) ? { n: Number(value) } : {}),
            ...(expiry === undefined
              ? {}
              : {
                  [TTL_FIELD]: new FsTimestamp(new Date(expiry).toISOString()),
                }),
          }),
        },
      ]),
    );
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    await this.guard(() =>
      this.options.client.commit([{ kind: "delete", path }]),
    );
  }

  async increment(
    key: string,
    by: number,
    options?: { ttlSec?: number },
  ): Promise<number> {
    const path = this.path(key);
    if (!Number.isSafeInteger(by))
      throw new InvalidCounterError("Increment must be a safe integer");
    this.expiry(options?.ttlSec); // validate before any request
    const { client } = this.options;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const outcome = await this.guard(async () => {
        const doc = await client.get(path);
        if (doc && !this.expired(doc)) {
          const n = doc.fields.n;
          if (!n || !("integerValue" in n))
            throw new InvalidCounterError("Counter must be decimal");
          if (!Number.isSafeInteger(Number(n.integerValue) + by))
            throw new InvalidCounterError("Counter must be a safe integer");
          try {
            // A server-side increment: concurrent increments of one live counter commute.
            const result = await client.commit([
              {
                kind: "set",
                path,
                fields: encodeFields({ c: true }),
                mask: ["c"],
                increments: [{ field: "n", by }],
                precondition: { exists: true },
              },
            ]);
            const value = result.writeResults[0]?.transformResults[0];
            if (!value || !("integerValue" in value))
              throw new KVError("Invalid Firestore counter update response");
            const next = Number(value.integerValue);
            if (!Number.isSafeInteger(next))
              throw new InvalidCounterError("Counter must be a safe integer");
            return next;
          } catch (error) {
            if (error instanceof FirestoreNotFoundError) return undefined;
            throw error;
          }
        }
        // Absent or expired: (re)create; TTL applies on creation only.
        const expiry = this.expiry(options?.ttlSec);
        try {
          await client.commit([
            {
              kind: "set",
              path,
              fields: encodeFields({
                v: String(by),
                n: by,
                c: true,
                ...(expiry === undefined
                  ? {}
                  : {
                      [TTL_FIELD]: new FsTimestamp(
                        new Date(expiry).toISOString(),
                      ),
                    }),
              }),
              precondition: doc
                ? { updateTime: doc.updateTime }
                : { exists: false },
            },
          ]);
          return by;
        } catch (error) {
          if (
            error instanceof FirestoreAlreadyExistsError ||
            error instanceof FirestorePreconditionError
          )
            return undefined;
          throw error;
        }
      });
      if (outcome !== undefined) return outcome;
      await this.sleep(attempt);
    }
    throw new KVUnavailableError(
      "Firestore increment contention limit reached",
    );
  }
}

export function create({
  config,
  bindings,
  environment = {},
}: CreateContext<Config, Record<string, unknown>>): FirestoreKV {
  const database = bindings[DATABASE_BINDING] ?? config.databaseId;
  if (typeof database !== "string" || !database)
    throw new Error("Missing Firestore KV database binding");
  const host = environment.FIRESTORE_EMULATOR_HOST;
  const endpoint = config.emulatorEndpoint
    ? new URL(config.emulatorEndpoint).origin
    : host
      ? `http://${host}`
      : undefined;
  const accessToken = bindings.accessToken;
  // The Cloud Run platform injects the gcp-auth token source as the `accessToken` host binding.
  if (!endpoint && typeof accessToken !== "function")
    throw new Error("Missing Firestore access token source");
  const clock = bindings.clock;
  return new FirestoreKV({
    client: new FirestoreRestClient({
      projectId: config.projectId,
      databaseId: database,
      ...(endpoint ? { endpoint } : {}),
      ...(typeof accessToken === "function"
        ? { accessToken: accessToken as () => Promise<string> }
        : {}),
      ...(config.requestTimeoutMs
        ? { requestTimeoutMs: config.requestTimeoutMs }
        : {}),
    }),
    ...(typeof clock === "object" &&
    clock !== null &&
    "now" in clock &&
    typeof clock.now === "function"
      ? { clock: clock as Clock }
      : {}),
  });
}
