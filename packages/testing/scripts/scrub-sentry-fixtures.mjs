#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg || process.argv.length !== 4) {
  throw new Error(
    "Usage: node scrub-sentry-fixtures.mjs <raw-directory> <output-directory>",
  );
}
const input = resolve(inputArg);
const output = resolve(outputArg);
const repo = resolve(import.meta.dirname, "../../..");
const secrets = [hostname(), userInfo().username].filter(Boolean);
const pathPatterns = [repo, repo.replaceAll("\\", "/")];

function cleanString(value) {
  let result = value;
  for (const path of pathPatterns)
    result = result.replaceAll(path, "/fixture/project");
  // Also remove the repository path from captures made on a different macOS or Linux user account.
  result = result.replace(
    /\/(?:Users|home)\/[^/\s"']+\/Source\/errtraq(?=\/|\b)/g,
    "/fixture/project",
  );
  for (const secret of secrets) result = result.replaceAll(secret, "fixture");
  return result;
}
const replacements = {
  device: {
    arch: "x86_64",
    memory_size: 1073741824,
    free_memory: 536870912,
    processor_count: 2,
    cpu_description: "Fixture CPU",
    processor_frequency: 2000,
  },
  os: {
    name: "Fixture OS",
    kernel_version: "1.0.0",
    version: "1.0.0",
    build: "fixture-build",
  },
  app: {
    app_start_time: "2024-01-01T00:00:00.000Z",
    app_memory: 67108864,
    free_memory: 536870912,
  },
  culture: { locale: "en-US", timezone: "UTC" },
};
function neutral(value, context, field = "") {
  if (Array.isArray(value)) return value.map((item) => neutral(item, context));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        cleanString(k),
        neutral(v, context, k),
      ]),
    );
  const replacement = replacements[context]?.[field];
  if (replacement !== undefined && typeof replacement === typeof value)
    return replacement;
  if (typeof value === "string") return "fixture";
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  return value;
}
function cleanAttribute(name, attribute) {
  if (!attribute || typeof attribute !== "object" || Array.isArray(attribute))
    return clean(attribute, name);
  const [prefix, ...rest] = name.split(".");
  const field = rest.join(".");
  if (
    ["device", "os", "app", "culture", "cloud_resource"].includes(prefix) ||
    name === "process.runtime.engine.version"
  ) {
    const fieldNames = {
      archs: "arch",
      start_time: "app_start_time",
      memory: "app_memory",
    };
    const mapped = fieldNames[field] ?? field;
    let value = attribute.value;
    if (name === "process.runtime.engine.version" && typeof value === "string")
      value = "fixture-engine";
    else if (field === "archs" && Array.isArray(value))
      value = value.map(() => "x86_64");
    else value = neutral(value, prefix, mapped);
    return { ...clean(attribute, name), value };
  }
  return clean(attribute, name);
}
function clean(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => clean(item));
  if (value && typeof value === "object") {
    const result = {};
    for (const [name, item] of Object.entries(value)) {
      if (key === "attributes")
        result[cleanString(name)] = cleanAttribute(name, item);
      else if (name === "server_name" && typeof item === "string")
        result[cleanString(name)] = "fixture-host";
      else if (
        key === "contexts" &&
        ["device", "os", "app", "culture", "cloud_resource"].includes(name)
      )
        result[cleanString(name)] = neutral(item, name);
      else if (
        key === "runtime" &&
        name === "version" &&
        typeof item === "string"
      )
        result[cleanString(name)] = "v22.0.0";
      else result[cleanString(name)] = clean(item, name);
    }
    return result;
  }
  return typeof value === "string" ? cleanString(value) : value;
}
function scrubBinary(payload) {
  let bytes = payload;
  for (const secret of [...pathPatterns, ...secrets]) {
    const needle = Buffer.from(secret);
    if (!needle.length) continue;
    const chunks = [];
    let start = 0;
    for (
      let at = bytes.indexOf(needle);
      at !== -1;
      at = bytes.indexOf(needle, start)
    ) {
      chunks.push(bytes.subarray(start, at), Buffer.from("fixture"));
      start = at + needle.length;
    }
    chunks.push(bytes.subarray(start));
    bytes = Buffer.concat(chunks);
  }
  return Buffer.from(
    bytes
      .toString("latin1")
      .replace(
        /\/(?:Users|home)\/[^/\s"']+\/Source\/errtraq(?=\/|\b)/g,
        "/fixture/project",
      ),
    "latin1",
  );
}
function scrubPayload(payload) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return Buffer.from(JSON.stringify(clean(JSON.parse(text))));
  } catch {
    return scrubBinary(payload);
  }
}
function scrubEnvelope(bytes) {
  let pos = 0;
  function line() {
    const end = bytes.indexOf(10, pos);
    const stop = end < 0 ? bytes.length : end;
    const result = bytes.subarray(
      pos,
      stop > pos && bytes[stop - 1] === 13 ? stop - 1 : stop,
    );
    pos = end < 0 ? bytes.length : end + 1;
    return result;
  }
  const envelopeHeader = clean(JSON.parse(line().toString("utf8")));
  const parts = [Buffer.from(`${JSON.stringify(envelopeHeader)}\n`)];
  while (pos < bytes.length) {
    if (bytes[pos] === 10) {
      pos++;
      continue;
    }
    if (bytes[pos] === 13 && bytes[pos + 1] === 10) {
      pos += 2;
      continue;
    }
    const headers = clean(JSON.parse(line().toString("utf8")));
    let payload;
    if (headers.length !== undefined) {
      if (
        !Number.isSafeInteger(headers.length) ||
        headers.length < 0 ||
        pos + headers.length > bytes.length
      )
        throw new Error("Invalid envelope item length");
      payload = bytes.subarray(pos, pos + headers.length);
      pos += headers.length;
      if (pos < bytes.length && bytes[pos] === 13 && bytes[pos + 1] === 10)
        pos += 2;
      else if (pos < bytes.length && bytes[pos] === 10) pos++;
      else if (pos < bytes.length)
        throw new Error("Missing envelope delimiter");
    } else payload = line();
    payload = scrubPayload(payload);
    // Lengths also protect binary payloads containing newlines.
    headers.length = payload.length;
    parts.push(
      Buffer.from(`${JSON.stringify(headers)}\n`),
      payload,
      Buffer.from("\n"),
    );
  }
  return Buffer.concat(parts);
}
await mkdir(output, { recursive: true });
for (const name of await readdir(input)) {
  if (!name.endsWith(".envelope")) continue;
  const scrubbed = scrubEnvelope(await readFile(join(input, name)));
  await writeFile(join(output, name), scrubbed);
  if (name === "large.envelope")
    await writeFile(join(output, `${name}.gz`), gzipSync(scrubbed));
}
