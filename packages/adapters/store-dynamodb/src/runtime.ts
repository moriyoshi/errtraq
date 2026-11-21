import { AwsRequestError, awsRequest } from "@errtraq/aws-signing";
import type { ActiveStore, Clock, CreateContext, Logger } from "@errtraq/core";
import {
  DynamoStoreAccessDeniedError,
  DynamoStoreError,
  DynamoStoreThrottledError,
  DynamoStoreUnavailableError,
  DynamoTransactionCanceledError,
} from "./errors.js";
import { eventRepository } from "./events.js";
import { issueRepository } from "./issues.js";
import { metaRepository } from "./meta.js";
import { projectRepository } from "./projects.js";
import { recordEvent } from "./record-event.js";
import { releaseRepository } from "./releases.js";
import type { Config } from "./stack.js";

export {
  DynamoStoreAccessDeniedError,
  DynamoStoreError,
  DynamoStoreThrottledError,
  DynamoStoreUnavailableError,
} from "./errors.js";

type Environment = Readonly<Record<string, string | undefined>>;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

export interface DynamoStoreOptions {
  table: string;
  region: string;
  environment: Environment;
  endpoint?: string;
  indexShards?: number;
  clock?: Clock;
  logger?: Logger;
  fetch?: typeof fetch;
}
/** Runtime-only DynamoDB store skeleton. The table layout is provisioned by Terraform. */
export class DynamoStore implements ActiveStore {
  readonly capabilities = {
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
  };
  private readonly endpoint: string;
  private shards?: number;
  constructor(private readonly options: DynamoStoreOptions) {
    if (!options.table || !options.region)
      throw new Error("DynamoDB store table and region are required");
    if (
      options.indexShards !== undefined &&
      (!Number.isInteger(options.indexShards) ||
        options.indexShards < 1 ||
        options.indexShards > 4)
    )
      throw new Error("Invalid DynamoDB store shard count");
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
      throw new Error("Invalid DynamoDB store endpoint");
    this.endpoint = url.origin;
  }
  get table(): string {
    return this.options.table;
  }
  async request(action: string, input: ObjectValue): Promise<ObjectValue> {
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
        allowHttpErrors:
          action === "TransactWriteItems" &&
          typeof input.ClientRequestToken === "string",
      });
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new DynamoStoreError("Invalid DynamoDB response");
      }
      const data = object(result);
      if (!data) throw new DynamoStoreError("Invalid DynamoDB response");
      if (!response.ok) {
        const code = response.headers.get("x-amz-error-code");
        if (code === "TransactionCanceledException") {
          const reasons = Array.isArray(data.CancellationReasons)
            ? data.CancellationReasons.map((value: unknown) => {
                const reason = object(value);
                return {
                  ...(typeof reason?.Code === "string" &&
                  /^[A-Za-z]+$/.test(reason.Code)
                    ? { code: reason.Code }
                    : {}),
                  ...(reason?.Item ? { item: reason.Item } : {}),
                };
              })
            : [];
          throw new DynamoTransactionCanceledError(reasons);
        }
        throw new AwsRequestError(
          "dynamodb",
          code ?? undefined,
          response.status,
          response.status === 429 ||
            response.status >= 500 ||
            [
              "ProvisionedThroughputExceededException",
              "ThrottlingException",
              "RequestLimitExceeded",
              "Throttling",
            ].includes(code ?? ""),
          response.status >= 500,
        );
      }
      return data;
    } catch (error) {
      if (!(error instanceof AwsRequestError)) throw error;
      this.options.logger?.warn("DynamoDB store request failed", {
        code: error.code,
        retryable: error.retryable,
      });
      const args = [
        "DynamoDB store request failed",
        error.code,
        error.retryable,
        error.ambiguous,
      ] as const;
      if (
        error.status === 403 ||
        error.code === "AccessDeniedException" ||
        error.code === "CredentialsUnavailable"
      )
        throw new DynamoStoreAccessDeniedError(...args);
      if (error.retryable && error.status !== undefined && error.status < 500)
        throw new DynamoStoreThrottledError(...args);
      if (error.retryable || error.code === "Timeout")
        throw new DynamoStoreUnavailableError(...args);
      throw new DynamoStoreError(...args);
    }
  }
  async migrate(): Promise<void> {
    const result = await this.request("GetItem", {
      TableName: this.options.table,
      Key: { PK: { S: "META|schema" }, SK: { S: "DATA" } },
      ConsistentRead: true,
    });
    const n = object(object(result.Item)?.projectTimeShards)?.N;
    if (typeof n !== "string" || !/^[1-4]$/.test(n))
      throw new DynamoStoreError(
        "DynamoDB store shard metadata is missing or invalid",
      );
    const shards = Number(n);
    if (
      this.options.indexShards !== undefined &&
      this.options.indexShards !== shards
    )
      throw new DynamoStoreError(
        "DynamoDB store shard count differs from table metadata",
      );
    this.shards = shards;
  }
  /** The persisted count is available after migrate has verified the table. */
  get indexShards(): number | undefined {
    return this.shards;
  }
  recordEvent: ActiveStore["recordEvent"] = recordEvent(
    this,
    () => this.shards,
  );
  projects: ActiveStore["projects"] = projectRepository(this);
  issues: ActiveStore["issues"] = issueRepository(this);
  events: ActiveStore["events"] = eventRepository(this, () => this.shards);
  releases: ActiveStore["releases"] = releaseRepository(this);
  meta: ActiveStore["meta"] = metaRepository(this);
}
export function create({
  config,
  bindings,
  environment = {},
  logger,
}: CreateContext<Config>): DynamoStore {
  const table = bindings.ERRTRAQ_STORE_TABLE;
  if (typeof table !== "string" || !table)
    throw new Error("Missing DynamoDB store table binding");
  const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Missing DynamoDB region (AWS_REGION)");
  const clock = bindings.clock;
  return new DynamoStore({
    table,
    region,
    environment,
    endpoint: environment.AWS_ENDPOINT_URL_DYNAMODB,
    indexShards: config.indexShards,
    logger,
    ...(typeof clock === "object" &&
    clock !== null &&
    "now" in clock &&
    typeof clock.now === "function"
      ? { clock: clock as Clock }
      : {}),
  });
}
