import { AwsRequestError, awsRequest } from "@errtraq/aws-signing";
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
export interface DynamoKVOptions {
  table: string;
  region: string;
  environment: Environment;
  endpoint?: string;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
  clock?: Clock;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
/** Numeric counter and original string are updated together under a revision condition. */
export class DynamoKV implements KV {
  private readonly endpoint: string;
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
    try {
      const response = await awsRequest({
        service: "dynamodb",
        region: this.options.region,
        url: `${this.endpoint}/`,
        method: "POST",
        body: JSON.stringify(input),
        protocol: "json",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": `DynamoDB_20120810.${action}`,
        },
        credentials: () => ({
          accessKeyId: this.options.environment.AWS_ACCESS_KEY_ID ?? "",
          secretAccessKey: this.options.environment.AWS_SECRET_ACCESS_KEY ?? "",
          sessionToken: this.options.environment.AWS_SESSION_TOKEN,
        }),
        fetch: this.options.fetch,
        sleep: this.options.sleep,
        random: this.options.random,
        requestTimeoutMs: this.options.requestTimeoutMs,
        overallTimeoutMs: this.options.overallTimeoutMs,
        signal: this.options.signal,
      });
      return (await response.json()) as Data;
    } catch (error) {
      if (!(error instanceof AwsRequestError)) throw error;
      const args = [error.message, error.code, error.ambiguous] as const;
      let mapped: KVError;
      if (
        error.code === "CredentialsUnavailable" ||
        error.status === 403 ||
        error.code === "AccessDeniedException"
      )
        mapped = new KVAccessDeniedError(...args);
      else if (
        error.retryable &&
        error.status !== undefined &&
        error.status < 500
      )
        mapped = new KVThrottledError(...args);
      else if (error.retryable || error.code === "Timeout")
        mapped = new KVUnavailableError(...args);
      else mapped = new KVError(...args);
      Object.defineProperty(mapped, "cause", { value: error });
      throw mapped;
    }
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
    overallTimeoutMs: config.overallTimeoutMs,
    clock:
      typeof bindings.clock === "object" &&
      bindings.clock !== null &&
      "now" in bindings.clock &&
      typeof bindings.clock.now === "function"
        ? (bindings.clock as Clock)
        : undefined,
  });
}
