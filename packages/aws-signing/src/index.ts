import { AwsV4Signer } from "aws4fetch";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export interface AwsSignInput extends AwsCredentials {
  method?: string;
  url: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  service?: string;
  region?: string;
  datetime?: string;
  signQuery?: boolean;
  appendSessionToken?: boolean;
  allHeaders?: boolean;
  singleEncode?: boolean;
}
/** Sign an AWS HTTP request with WebCrypto; credentials are supplied by the caller. */
export function signAwsRequest(input: AwsSignInput) {
  return new AwsV4Signer(input).sign();
}

export class AwsRequestError extends Error {
  override name = "AwsRequestError";
  constructor(
    readonly service: string,
    readonly code: string | undefined,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly ambiguous = false,
    message?: string,
  ) {
    super(
      message ??
        `${service} request failed${status === undefined ? "" : ` (${status})`}${code ? `: ${code}` : ""}`,
    );
  }
}
export type AwsService = "s3" | "sqs" | "dynamodb" | (string & {});
export interface AwsRequestOptions {
  service: AwsService;
  region: string;
  url: string;
  method: string;
  credentials: () => AwsCredentials | Promise<AwsCredentials>;
  headers?: HeadersInit;
  body?: string | Uint8Array;
  protocol: "json" | "s3";
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  signal?: AbortSignal;
  allowHttpErrors?: boolean;
  mapBodyError?: (error: AwsRequestError) => Error;
}
const retryCodes: Record<string, ReadonlySet<string>> = {
  sqs: new Set([
    "RequestThrottled",
    "ThrottlingException",
    "OverLimit",
    "Throttling",
  ]),
  dynamodb: new Set([
    "ProvisionedThroughputExceededException",
    "ThrottlingException",
    "RequestLimitExceeded",
    "Throttling",
  ]),
  s3: new Set(["SlowDown", "Throttling", "ThrottlingException"]),
};
function cleanCode(
  raw: string | null,
  credentials: AwsCredentials,
): string | undefined {
  const candidate =
    (raw ?? "").split("#").at(-1)?.split(":").at(-1)?.split(";")[0] ?? "";
  const secrets = [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    credentials.sessionToken,
  ].filter((x): x is string => !!x);
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(candidate) &&
    !secrets.some((x) => candidate.includes(x))
    ? candidate
    : undefined;
}
function errorCode(
  protocol: "json" | "s3",
  text: string,
  headers: Headers,
  credentials: AwsCredentials,
): string | undefined {
  let raw =
    headers.get("x-amz-error-code") ??
    headers.get("x-amzn-errortype") ??
    headers.get("x-amzn-query-error");
  if (protocol === "json") {
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === "object") {
        if ("__type" in data && typeof data.__type === "string")
          raw = data.__type;
        else if (!raw && "code" in data && typeof data.code === "string")
          raw = data.code;
      }
    } catch {
      /* Headers may still contain the code. */
    }
  } else {
    const match = text.match(
      /<(?:[A-Za-z0-9_-]+:)?Code>\s*([A-Za-z][A-Za-z0-9._-]{0,127})\s*<\/(?:[A-Za-z0-9_-]+:)?Code>/,
    );
    if (match?.[1]) raw = match[1];
  }
  return cleanCode(raw, credentials);
}
/** Full-jitter delay shared with retryable per-entry batch failures. */
export function awsBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * 500 * 2 ** attempt);
}
function retryAfter(value: string | null): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value))
    return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}
async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  let left = ms;
  do {
    const step = Math.min(left, 2147483647);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", canceled);
        resolve();
      }, step);
      const canceled = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", canceled);
        reject(new Error("Aborted"));
      };
      if (signal.aborted) canceled();
      else signal.addEventListener("abort", canceled, { once: true });
    });
    left -= step;
  } while (left > 0);
}

function guarded<T>(
  promise: Promise<T>,
  ms: number,
  service: string,
  signal: AbortSignal | undefined,
  abort: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => {
        reject(new AwsRequestError(service, "Aborted", undefined, false, true));
        abort();
      });
    if (signal?.aborted) {
      void promise.catch(() => {});
      reject(new AwsRequestError(service, "Aborted", undefined, false, true));
      abort();
      return;
    }
    if (ms <= 0) {
      void promise.catch(() => {});
      reject(new AwsRequestError(service, "Timeout", undefined, true, true));
      abort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () =>
        finish(() => {
          reject(
            new AwsRequestError(service, "Timeout", undefined, true, true),
          );
          abort();
        }),
      Math.max(0, ms),
    );
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
function timedBody(
  body: ReadableStream<Uint8Array>,
  ms: number,
  end: number,
  service: string,
  signal: AbortSignal | undefined,
  abort: () => void,
  map?: (error: AwsRequestError) => Error,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let closed = false;
  const onAbort = () => abort();
  const deadlineTimer = setTimeout(onAbort, Math.max(0, end - Date.now()));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const release = () => {
    if (!closed) {
      closed = true;
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await guarded(
          reader.read(),
          Math.min(ms, Math.max(0, end - Date.now())),
          service,
          signal,
          abort,
        );
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        const failure = signal?.aborted
          ? new AwsRequestError(service, "Aborted", undefined, false, true)
          : Date.now() >= end
            ? new AwsRequestError(service, "Timeout", undefined, true, true)
            : error;
        abort();
        void reader
          .cancel(failure)
          .catch(() => {})
          .finally(release);
        controller.error(
          failure instanceof AwsRequestError && map ? map(failure) : failure,
        );
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        abort();
        release();
      }
    },
  });
}
/** Signed, bounded AWS request. JSON responses are validated; S3 bodies remain streaming. */
export async function awsRequest(
  options: AwsRequestOptions,
): Promise<Response> {
  const { service, region, method, url, credentials, protocol } = options;
  const perAttempt = options.requestTimeoutMs ?? 10_000,
    overall = options.overallTimeoutMs ?? 25_000,
    idle = options.bodyIdleTimeoutMs ?? 30_000;
  if (
    ![perAttempt, overall, idle].every(
      (x) => Number.isSafeInteger(x) && x > 0 && x <= 300_000,
    )
  )
    throw new RangeError("Invalid AWS request timeout");
  const end = Date.now() + overall,
    fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
  let expired = false,
    ambiguous = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    let creds: AwsCredentials;
    const abort = new AbortController();
    const remaining = () => Math.max(0, end - Date.now());
    const pause = async (delay: number) => {
      const backoff = new AbortController();
      await guarded(
        options.sleep
          ? options.sleep(delay)
          : defaultSleep(delay, backoff.signal),
        remaining(),
        service,
        options.signal,
        () => backoff.abort(),
      );
    };
    try {
      creds = await guarded(
        Promise.resolve().then(credentials),
        remaining(),
        service,
        options.signal,
        () => abort.abort(),
      );
    } catch (error) {
      if (error instanceof AwsRequestError) throw error;
      throw new AwsRequestError(
        service,
        "CredentialsUnavailable",
        undefined,
        false,
        false,
      );
    }
    if (!creds.accessKeyId || !creds.secretAccessKey)
      throw new AwsRequestError(
        service,
        "CredentialsUnavailable",
        undefined,
        false,
        false,
      );
    const signed = await guarded(
      signAwsRequest({
        url,
        method,
        headers: options.headers,
        body: options.body as BodyInit | undefined,
        ...creds,
        service,
        region,
      }),
      remaining(),
      service,
      options.signal,
      () => abort.abort(),
    );
    let response: Response, text: string | undefined;
    try {
      const result = await guarded(
        (async () => {
          const result = await fetcher(signed.url, {
            method,
            headers: signed.headers,
            body: options.body as BodyInit | undefined,
            redirect: "manual",
            signal: abort.signal,
          });
          const text =
            protocol === "json" || !result.ok ? await result.text() : undefined;
          return { response: result, text };
        })(),
        Math.min(perAttempt, remaining()),
        service,
        options.signal,
        () => abort.abort(),
      );
      response = result.response;
      text = result.text;
    } catch (error) {
      abort.abort();
      if (error instanceof AwsRequestError && error.code === "Aborted")
        throw error;
      ambiguous = true;
      if (attempt === 3 || remaining() <= 0)
        throw new AwsRequestError(
          service,
          remaining() <= 0 ||
            (error instanceof AwsRequestError && error.code === "Timeout")
            ? "Timeout"
            : "NetworkError",
          undefined,
          true,
          true,
        );
      const delay = awsBackoffMs(attempt, options.random);
      await pause(delay);
      continue;
    }
    const code = errorCode(protocol, text ?? "", response.headers, creds);
    if (
      !response.ok &&
      (code === "ExpiredToken" || code === "ExpiredTokenException") &&
      !expired
    ) {
      expired = true;
      attempt--;
      continue;
    }
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      (!!code && !!retryCodes[service]?.has(code));
    if (!response.ok && retryable && attempt < 3) {
      if (response.status >= 500) ambiguous = true;
      const delay = Math.max(
        retryAfter(response.headers.get("retry-after")),
        awsBackoffMs(attempt, options.random),
      );
      await pause(delay);
      continue;
    }
    if (!response.ok && !options.allowHttpErrors)
      throw new AwsRequestError(
        service,
        code,
        response.status,
        retryable,
        ambiguous || response.status >= 500,
      );
    if (protocol === "json" && response.ok) {
      try {
        const parsed: unknown = JSON.parse(text ?? "");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error();
      } catch {
        throw new AwsRequestError(
          service,
          "InvalidResponse",
          response.status,
          false,
          ambiguous,
        );
      }
    }
    if (text !== undefined) {
      const headers = new Headers(response.headers);
      if (code) headers.set("x-amz-error-code", code);
      return new Response(text || null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (!response.body) return response;
    return new Response(
      timedBody(
        response.body,
        idle,
        end,
        service,
        options.signal,
        () => abort.abort(),
        options.mapBodyError,
      ),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  }
  throw new AwsRequestError(service, "RetryLimit", undefined, true, ambiguous);
}
