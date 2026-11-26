import { z } from "zod";

/**
 * Per-section schemas for `event.entries[].data` and the event's context objects. Parsed with
 * `safeParse` at render time; a section that does not parse falls back to its raw JSON.
 */

const text = z.string().nullish();
const num = z.number().nullish();

export const frameSchema = z.object({
  filename: text,
  abs_path: text,
  module: text,
  function: text,
  lineno: num,
  colno: num,
  in_app: z.boolean().nullish(),
  context_line: text,
  pre_context: z.array(z.string()).nullish(),
  post_context: z.array(z.string()).nullish(),
  vars: z.record(z.string(), z.unknown()).nullish(),
});
export type Frame = z.infer<typeof frameSchema>;

export const exceptionValueSchema = z.object({
  type: text,
  value: text,
  module: text,
  mechanism: z
    .object({
      type: text,
      handled: z.boolean().nullish(),
      description: text,
    })
    .loose()
    .nullish(),
  stacktrace: z.object({ frames: z.array(frameSchema).nullish() }).nullish(),
});
export type ExceptionValue = z.infer<typeof exceptionValueSchema>;

/**
 * Sentry's API wraps the list as `{ values: [...] }`; raw SDK payloads (and errtraq, which passes
 * the payload section through) may carry the bare array. Both parse to the plain array.
 */
function listOf<T extends z.ZodType>(item: T) {
  return z
    .union([z.array(item), z.object({ values: z.array(item).nullish() })])
    .transform((data): z.output<T>[] =>
      Array.isArray(data) ? data : (data.values ?? []),
    );
}

export const exceptionSchema = listOf(exceptionValueSchema);

export const breadcrumbSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).nullish(),
  type: text,
  category: text,
  level: text,
  message: text,
  data: z.unknown().optional(),
});
export type Breadcrumb = z.infer<typeof breadcrumbSchema>;

export const breadcrumbsSchema = listOf(breadcrumbSchema);

/** Headers arrive as `[[k, v]]` pairs (Sentry) or as an object (raw SDK payloads). */
const headersSchema = z
  .union([
    z.array(z.tuple([z.string(), z.unknown()])),
    z.record(z.string(), z.unknown()),
  ])
  .nullish();

export const requestSchema = z.object({
  url: text,
  method: text,
  query_string: z.unknown().optional(),
  headers: headersSchema,
  data: z.unknown().optional(),
  env: z.record(z.string(), z.unknown()).nullish(),
});
export type RequestData = z.infer<typeof requestSchema>;

export const messageSchema = z.object({
  message: text,
  formatted: text,
});

export function headerPairs(
  headers: RequestData["headers"],
): [string, string][] {
  if (!headers) return [];
  const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
  return pairs.map(([k, v]) => [k, display(v)]);
}

/** Render any JSON value as display text (never as HTML). */
export function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
