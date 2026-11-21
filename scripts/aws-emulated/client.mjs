import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function localEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Emulator endpoint must be a loopback HTTP origin");
  return url.origin;
}
export function client(endpoint) {
  endpoint = localEndpoint(endpoint);
  async function request(service, path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=emulator/20260101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`,
    );
    const response = await fetch(`${endpoint}${path}`, {
      ...options,
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${service} ${response.status}: ${text.slice(0, 500)}`);
    return { text, headers: response.headers, status: response.status };
  }
  async function json(service, action, body) {
    const target =
      service === "dynamodb"
        ? `DynamoDB_20120810.${action}`
        : `AmazonSQS.${action}`;
    const result = await request(service, "/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": target,
      },
      body: JSON.stringify(body),
    });
    return result.text ? JSON.parse(result.text) : {};
  }
  return {
    endpoint,
    request,
    async emptyBucket(bucket) {
      for (;;) {
        const page = await request(
          "s3",
          `/${bucket}?list-type=2&encoding-type=url`,
        );
        const keys = [...page.text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) =>
          decodeURIComponent(m[1]),
        );
        if (!keys.length) break;
        for (const key of keys)
          await request(
            "s3",
            `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`,
            { method: "DELETE" },
          );
      }
    },
    dynamo: (action, body) => json("dynamodb", action, body),
    sqs: (action, body) => json("sqs", action, body),
  };
}
export const unique = () => `errtraq-${randomUUID().replaceAll("-", "")}`;
export async function check(results, name, action) {
  try {
    await action();
    results[name] = { supported: true };
  } catch (error) {
    results[name] = {
      supported: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
export function element(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return match?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
export { assert };
