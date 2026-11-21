import { signAwsRequest } from "@errtraq/aws-signing";
import type { Clock, CreateContext, KV } from "@errtraq/core";
import {
  InvalidCounterError,
  KVAccessDeniedError,
  KVError,
  KVInvalidKeyError,
  KVThrottledError,
  KVUnavailableError,
} from "@errtraq/core/kv";
import type { Config } from "./stack.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Row = {
  value: string;
  revision: string;
  counter?: number;
  expiresMs?: number;
};
type Data = Record<string, unknown>;
const obj = (value: unknown): Data | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : undefined;
const decimal = (value: string): boolean =>
  /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
const throttled = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "Throttling",
]);
export interface DynamoKVOptions {
  table: string;
  region: string;
  environment: Environment;
  endpoint?: string;
  requestTimeoutMs?: number;
  clock?: Clock;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
/** Numeric counter and original string are updated together under a revision condition. */
export class DynamoKV implements KV {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly options: DynamoKVOptions) {
    if (!options.table || !options.region)
      throw new Error("DynamoDB table and region are required");
    const url = new URL(
      options.endpoint ??
        `https://dynamodb.${options.region}.${options.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Invalid DynamoDB endpoint");
    this.endpoint = url.origin;
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.timeout = options.requestTimeoutMs ?? 10000;
    if (
      !Number.isInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 300000
    )
      throw new RangeError("Invalid DynamoDB timeout");
    this.sleep =
      options.sleep ??
      (async (ms) => {
        let left = ms;
        do {
          const step = Math.min(left, 2147483647);
          await new Promise((resolve) => setTimeout(resolve, step));
          left -= step;
        } while (left > 0);
      });
  }
  private now(): number {
    const time = this.options.clock
      ? Date.parse(this.options.clock.now())
      : Date.now();
    if (!Number.isFinite(time)) throw new Error("Invalid KV clock");
    return time;
  }
  private key(key: string) {
    const bytes =
      typeof key === "string"
        ? new TextEncoder().encode(`KV#${key}`)
        : new Uint8Array();
    if (
      typeof key !== "string" ||
      !key ||
      bytes.length > 2048 ||
      new TextDecoder().decode(bytes) !== `KV#${key}`
    )
      throw new KVInvalidKeyError("Invalid DynamoDB KV key");
    return { PK: { S: `KV#${key}` }, SK: { S: "KV" } };
  }
  private expiry(ttlSec?: number): { ms: number; seconds: number } | undefined {
    if (ttlSec === undefined) return undefined;
    if (!Number.isFinite(ttlSec) || ttlSec < 0)
      throw new RangeError("Invalid KV TTL");
    const ms = Math.ceil(this.now() + ttlSec * 1000);
    if (
      !Number.isSafeInteger(ms) ||
      !Number.isSafeInteger(Math.ceil(ms / 1000))
    )
      throw new RangeError("Invalid KV TTL");
    return { ms, seconds: Math.ceil(ms / 1000) };
  }
  private async request(action: string, input: Data): Promise<Data> {
    const body = JSON.stringify(input);
    let expired = false,
      ambiguous = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const env = this.options.environment;
      const accessKeyId = env.AWS_ACCESS_KEY_ID,
        secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey)
        throw new KVAccessDeniedError("DynamoDB credentials are missing");
      const signed = await signAwsRequest({
        url: `${this.endpoint}/`,
        method: "POST",
        body,
        service: "dynamodb",
        region: this.options.region,
        accessKeyId,
        secretAccessKey,
        ...(env.AWS_SESSION_TOKEN
          ? { sessionToken: env.AWS_SESSION_TOKEN }
          : {}),
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": `DynamoDB_20120810.${action}`,
        },
      });
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response, text: string;
      try {
        ({ response, text } = await Promise.race([
          (async () => {
            const response = await this.fetcher(signed.url, {
              method: "POST",
              body,
              headers: signed.headers,
              signal: abort.signal,
              redirect: "manual",
            });
            return { response, text: await response.text() };
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new KVUnavailableError("DynamoDB request timed out"));
              abort.abort();
            }, this.timeout);
          }),
        ]));
      } catch {
        abort.abort();
        ambiguous = true;
        if (attempt === 3)
          throw new KVUnavailableError(
            `DynamoDB ${action} unavailable`,
            undefined,
            true,
          );
        await this.sleep(
          Math.floor(
            (this.options.random ?? Math.random)() * 500 * 2 ** attempt,
          ),
        );
        continue;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      let parsed: Data = {};
      try {
        parsed = obj(JSON.parse(text)) ?? {};
      } catch {
        if (response.ok)
          throw new KVError(`Invalid DynamoDB ${action} response`);
      }
      if (response.ok) return parsed;
      const raw =
        typeof parsed.__type === "string"
          ? parsed.__type
          : typeof parsed.code === "string"
            ? parsed.code
            : (response.headers.get("x-amzn-errortype") ?? "");
      const candidate = raw.split("#").at(-1)?.split(":").at(-1) || "";
      const sensitive = [
        env.AWS_ACCESS_KEY_ID,
        env.AWS_SECRET_ACCESS_KEY,
        env.AWS_SESSION_TOKEN,
      ].filter((value): value is string => !!value);
      const code =
        /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(candidate) &&
        !sensitive.some((value) => candidate.includes(value))
          ? candidate
          : undefined;
      if (code === "ExpiredTokenException" || code === "ExpiredToken") {
        if (!expired) {
          expired = true;
          attempt--;
          continue;
        }
      }
      if (
        (response.status === 429 ||
          response.status >= 500 ||
          (code && throttled.has(code))) &&
        attempt < 3
      ) {
        if (response.status >= 500) ambiguous = true;
        const after = response.headers.get("retry-after");
        const seconds =
          after && /^\d+$/.test(after)
            ? Math.min(Number(after) * 1000, Number.MAX_SAFE_INTEGER)
            : after
              ? Math.max(0, Date.parse(after) - Date.now())
              : 0;
        await this.sleep(
          Math.max(
            Number.isFinite(seconds) ? seconds : 0,
            Math.floor(
              (this.options.random ?? Math.random)() * 500 * 2 ** attempt,
            ),
          ),
        );
        continue;
      }
      const message = `DynamoDB ${action} failed (${response.status}${code ? `, ${code}` : ""})`;
      if ((code && throttled.has(code)) || response.status === 429)
        throw new KVThrottledError(message, code, ambiguous);
      if (response.status === 403 || code === "AccessDeniedException")
        throw new KVAccessDeniedError(message, code, ambiguous);
      if (response.status >= 500)
        throw new KVUnavailableError(message, code, true);
      throw new KVError(message, code, ambiguous);
    }
    throw new KVUnavailableError(
      `DynamoDB ${action} unavailable`,
      undefined,
      true,
    );
  }
  private async read(key: string): Promise<Row | undefined> {
    const result = await this.request("GetItem", {
      TableName: this.options.table,
      Key: this.key(key),
      ConsistentRead: true,
    });
    if (result.Item === undefined) return undefined;
    const item = obj(result.Item),
      value = obj(item?.value)?.S,
      revision = obj(item?.revision)?.S,
      counter = obj(item?.counter)?.N,
      active = obj(item?.counterActive)?.BOOL,
      expires = obj(item?.expiresMs)?.N;
    if (
      typeof value !== "string" ||
      typeof revision !== "string" ||
      (counter !== undefined &&
        (typeof counter !== "string" || !decimal(counter))) ||
      (active !== undefined && typeof active !== "boolean") ||
      (active === true && typeof counter !== "string") ||
      (expires !== undefined &&
        (typeof expires !== "string" || !decimal(expires)))
    )
      throw new KVError("Invalid DynamoDB KV item");
    return {
      value:
        active === true && typeof counter === "string"
          ? String(Number(counter))
          : value,
      revision,
      ...(typeof counter === "string" ? { counter: Number(counter) } : {}),
      ...(typeof expires === "string" ? { expiresMs: Number(expires) } : {}),
    };
  }
  async get(key: string): Promise<string | null> {
    const row = await this.read(key);
    return !row || (row.expiresMs !== undefined && row.expiresMs <= this.now())
      ? null
      : row.value;
  }
  async put(
    key: string,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<void> {
    const Key = this.key(key),
      expiry = this.expiry(options?.ttlSec);
    if (typeof value !== "string")
      throw new TypeError("KV value must be a string");
    await this.request("PutItem", {
      TableName: this.options.table,
      Item: {
        ...Key,
        value: { S: value },
        revision: { S: crypto.randomUUID() },
        ...(decimal(value) ? { counter: { N: String(Number(value)) } } : {}),
        ...(expiry
          ? {
              expiresMs: { N: String(expiry.ms) },
              expiresAt: { N: String(expiry.seconds) },
            }
          : {}),
      },
    });
  }
  async delete(key: string): Promise<void> {
    await this.request("DeleteItem", {
      TableName: this.options.table,
      Key: this.key(key),
    });
  }
  async increment(
    key: string,
    by: number,
    options?: { ttlSec?: number },
  ): Promise<number> {
    const Key = this.key(key);
    if (!Number.isSafeInteger(by))
      throw new InvalidCounterError("Increment must be a safe integer");
    // Validate TTL before any request; its value is recomputed only on actual creation.
    this.expiry(options?.ttlSec);
    for (let attempt = 0; attempt < 128; attempt++) {
      const observed = await this.read(key),
        live =
          observed &&
          (observed.expiresMs === undefined || observed.expiresMs > this.now())
            ? observed
            : undefined;
      if (live && !decimal(live.value))
        throw new InvalidCounterError("Counter must be decimal");
      const next = Number(live?.value ?? "0") + by;
      if (!Number.isSafeInteger(next))
        throw new InvalidCounterError("Counter must be a safe integer");
      const revision = crypto.randomUUID(),
        expiry = !live ? this.expiry(options?.ttlSec) : undefined;
      const names: Record<string, string> = {
        "#v": "value",
        "#r": "revision",
        "#c": "counter",
        "#active": "counterActive",
      };
      const values: Data = {
        ":value": { S: String(next) },
        ":revision": { S: revision },
        ":active": { BOOL: true },
      };
      let update = "SET #v = :value, #r = :revision, #active = :active";
      if (live?.counter !== undefined) {
        values[":by"] = { N: String(by) };
      } else if (!observed) {
        values[":by"] = { N: String(by) };
      } else {
        values[":counter"] = { N: String(next) };
        update += ", #c = :counter";
      }
      if (!live && expiry) {
        names["#ms"] = "expiresMs";
        names["#ttl"] = "expiresAt";
        values[":ms"] = { N: String(expiry.ms) };
        values[":ttl"] = { N: String(expiry.seconds) };
        update += observed
          ? ", #ms = :ms, #ttl = :ttl"
          : ", #ms = if_not_exists(#ms, :ms), #ttl = if_not_exists(#ttl, :ttl)";
      }
      if (!live && observed && !expiry) {
        names["#ms"] = "expiresMs";
        names["#ttl"] = "expiresAt";
        update += " REMOVE #ms, #ttl";
      }
      if (values[":by"]) update += " ADD #c :by";
      const condition = observed
        ? "#r = :previous"
        : "attribute_not_exists(PK)";
      if (observed) values[":previous"] = { S: observed.revision };
      try {
        const result = await this.request("UpdateItem", {
          TableName: this.options.table,
          Key,
          ConditionExpression: condition,
          UpdateExpression: update,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        });
        const actual = obj(obj(result.Attributes)?.counter)?.N;
        if (typeof actual !== "string" || !decimal(actual))
          throw new KVError("Invalid DynamoDB counter update response");
        return Number(actual);
      } catch (error) {
        if (
          !(error instanceof KVError) ||
          error.providerCode !== "ConditionalCheckFailedException"
        )
          throw error;
        if (error.ambiguous) {
          const after = await this.read(key);
          if (after?.revision === revision) return next;
          throw new KVUnavailableError(
            "DynamoDB increment outcome is ambiguous",
            undefined,
            true,
          );
        }
      }
    }
    throw new KVUnavailableError("DynamoDB increment contention limit reached");
  }
}
export function create({
  config,
  bindings,
  environment = {},
}: CreateContext<Config, Record<string, unknown>>): DynamoKV {
  const table = bindings.ERRTRAQ_KV_TABLE;
  if (typeof table !== "string" || !table)
    throw new Error("Missing DynamoDB KV table binding");
  const region =
    config.region ?? environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Missing DynamoDB region (AWS_REGION)");
  return new DynamoKV({
    table,
    region,
    environment,
    endpoint: config.endpoint ?? environment.AWS_ENDPOINT_URL_DYNAMODB,
    requestTimeoutMs: config.requestTimeoutMs,
    clock:
      typeof bindings.clock === "object" &&
      bindings.clock !== null &&
      "now" in bindings.clock &&
      typeof bindings.clock.now === "function"
        ? (bindings.clock as Clock)
        : undefined,
  });
}
