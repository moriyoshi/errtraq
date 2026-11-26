import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { main, ok, pool } from "./lib.mjs";

/**
 * GCS on a real project: the bucket's configuration, conditional (create-only) writes, the 404
 * wording that tells a missing bucket from a missing object, a resumable upload above one chunk,
 * list paging above 1000 objects under a dedicated probe prefix (deleted afterwards), and a V4
 * signed URL through `signBlob` when a signer service account is named.
 */
export const probe = {
  name: "gcs",
  description:
    "bucket settings, conditional write, 404 wording, resumable upload, paging above 1000, signed URL",
  run,
};

const API = "https://storage.googleapis.com/storage/v1";
const UPLOAD = "https://storage.googleapis.com/upload/storage/v1";
const encode = (key) => encodeURIComponent(key);

export async function realBlobStore(
  ctx,
  { bucket = ctx.names.bucket, signerEmail } = {},
) {
  const { GcsBlobStore } = await import("@moriyoshi/errtraq-blob-gcs/runtime");
  const emulator = ctx.env.STORAGE_EMULATOR_HOST;
  let signer;
  if (signerEmail) {
    const { IamSigner } = await import("@moriyoshi/errtraq-gcp-auth");
    const tokens = {
      getAccessToken: () => ctx.auth.accessToken(),
      getIdToken: () => Promise.reject(new Error("unsupported")),
    };
    signer = new IamSigner({ tokenSource: tokens, email: signerEmail });
  }
  return new GcsBlobStore({
    bucket,
    ...(emulator
      ? {
          endpoint: emulator.startsWith("http")
            ? emulator
            : `http://${emulator}`,
        }
      : {}),
    tokens: {
      getAccessToken: () => ctx.auth.accessToken(),
      getIdToken: () => Promise.reject(new Error("unsupported")),
    },
    ...(signer ? { signer } : {}),
    allowedPrefixes: ["g8-probe/"],
  });
}

export async function bucketSettings(ctx) {
  const response = await ctx.http("GET", `${API}/b/${ctx.names.bucket}`);
  if (
    !ctx.report.check(
      "bucket exists",
      ok(response),
      `status ${response.status}`,
    )
  )
    return;
  const bucket = response.json;
  const { report } = ctx;
  report.check(
    "uniform bucket-level access is on",
    bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
  );
  report.check(
    "public access prevention is enforced",
    bucket.iamConfiguration?.publicAccessPrevention === "enforced",
    () => `value ${bucket.iamConfiguration?.publicAccessPrevention}`,
  );
  report.check("object versioning is off", !bucket.versioning?.enabled);
  report.check(
    "soft delete is disabled (retention 0 s)",
    String(bucket.softDeletePolicy?.retentionDurationSeconds) === "0",
    () =>
      `retention ${bucket.softDeletePolicy?.retentionDurationSeconds ?? "unset"} s`,
  );
  report.check(
    "lifecycle rules are present",
    (bucket.lifecycle?.rule?.length ?? 0) >= 4,
    () => `${bucket.lifecycle?.rule?.length ?? 0} rules`,
  );
  report.check(
    "bucket is in the configured region",
    String(bucket.location ?? "").toLowerCase() === ctx.config.region,
  );
}

export async function conditionalWrite(ctx) {
  const { report } = ctx;
  const key = `g8-probe/${ctx.config.runId}/conditional`;
  const url = (query = "") =>
    `${UPLOAD}/b/${ctx.names.bucket}/o?uploadType=media&name=${encode(key)}${query}`;
  try {
    const first = await ctx.http("POST", url("&ifGenerationMatch=0"), {
      body: "one",
      headers: { "content-type": "text/plain" },
    });
    const second = await ctx.http("POST", url("&ifGenerationMatch=0"), {
      body: "two",
      headers: { "content-type": "text/plain" },
    });
    report.check(
      "a create-only write succeeds once and then fails with 412",
      ok(first) && second.status === 412,
      `${first.status}, ${second.status}`,
    );
    const overwrite = await ctx.http("POST", url(), {
      body: "three",
      headers: { "content-type": "text/plain" },
    });
    report.check(
      "an unconditional write overwrites and changes the generation",
      ok(overwrite) && overwrite.json?.generation !== first.json?.generation,
      `status ${overwrite.status}`,
    );
    const stale = await ctx.http(
      "POST",
      url(`&ifGenerationMatch=${first.json?.generation}`),
      { body: "four", headers: { "content-type": "text/plain" } },
    );
    report.check(
      "a write conditioned on a stale generation fails with 412",
      stale.status === 412,
      `status ${stale.status}`,
    );
  } finally {
    await ctx.http("DELETE", `${API}/b/${ctx.names.bucket}/o/${encode(key)}`, {
      raw: true,
    });
  }
}

/** The 404 body wording `blob-gcs` relies on to tell a missing bucket from a missing object. */
export async function notFoundWording(ctx) {
  const { report } = ctx;
  const object = await ctx.http(
    "GET",
    `${API}/b/${ctx.names.bucket}/o/${encode(`g8-probe/${ctx.config.runId}/absent`)}`,
  );
  const bucket = await ctx.http(
    "GET",
    `${API}/b/${ctx.config.stack}-g8-absent-${ctx.config.runId}-${ctx.config.project}/o/x`,
  );
  const objectMessage = String(object.json?.error?.message ?? "");
  const bucketMessage = String(bucket.json?.error?.message ?? "");
  // The classification in packages/adapters/blob-gcs: a bucket 404 mentions the bucket and not an object.
  const missingBucket = (message) =>
    /bucket/i.test(message) && !/object/i.test(message);
  report.check(
    "a missing object is a 404 that is not classified as a missing bucket",
    object.status === 404 && !missingBucket(objectMessage),
    () => `${object.status}: ${objectMessage}`,
  );
  report.check(
    "a missing bucket is a 404 (or 403 for a name another project owns) and is classified as a missing bucket",
    (bucket.status === 404 && missingBucket(bucketMessage)) ||
      bucket.status === 403,
    () => `${bucket.status}: ${bucketMessage}`,
  );
  report.info(
    "404 bodies",
    `object: ${objectMessage.replace(ctx.names.bucket, "<bucket>")}; bucket: ${bucketMessage}`,
  );
}

function patterned(size, seed) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 255;
  return bytes;
}

/** An object larger than one 8 MiB chunk goes through the resumable path and reads back intact. */
export async function resumableUpload(ctx) {
  const { report } = ctx;
  const store = await (ctx.deps.createBlobStore ?? realBlobStore)(ctx);
  const key = `g8-probe/${ctx.config.runId}/resumable`;
  const size = Number(ctx.flags["resumable-bytes"] ?? 9 * 1024 * 1024 + 123);
  const bytes = patterned(size, 7);
  const piece = 1024 * 1024;
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + piece));
      offset += piece;
    },
  });
  try {
    await store.put(key, stream, {
      size,
      contentType: "application/octet-stream",
    });
    const head = await store.head(key);
    report.check(
      "resumable upload stores every byte",
      head?.size === size,
      () => `size ${head?.size ?? "missing"} of ${size}`,
    );
    const body = await store.get(key);
    const read = new Uint8Array(await new Response(body).arrayBuffer());
    report.check(
      "the object reads back identical (CRC-32C verified by the adapter)",
      createHash("sha256").update(read).digest("hex") ===
        createHash("sha256").update(bytes).digest("hex"),
    );
  } finally {
    await store.delete(key).catch(() => undefined);
  }
}

/** More than 1000 objects: the adapter pages in order, with no gaps or duplicates. */
export async function listPaging(ctx) {
  const { report } = ctx;
  const store = await (ctx.deps.createBlobStore ?? realBlobStore)(ctx);
  const total = Number(ctx.flags.objects ?? 1205);
  const prefix = `g8-probe/${ctx.config.runId}/list/`;
  const keys = Array.from(
    { length: total },
    (_, i) => `${prefix}${String(i).padStart(5, "0")}`,
  );
  try {
    const uploaded = await pool(keys, 32, async (key) => {
      try {
        await store.put(key, new TextEncoder().encode("x"));
        return true;
      } catch {
        return false;
      }
    });
    report.check(
      "probe objects uploaded",
      uploaded.every(Boolean),
      `${uploaded.filter(Boolean).length} of ${total}`,
    );
    const listed = [];
    let cursor;
    let pages = 0;
    do {
      const page = await store.list(prefix, cursor, 1000);
      listed.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    const ascending = listed.every(
      (key, i) => i === 0 || (listed[i - 1] ?? "") < key,
    );
    report.check(
      "listing above 1000 objects returns every key once, in order",
      listed.length === total && ascending && new Set(listed).size === total,
      () => `${listed.length} of ${total} in ${pages} pages`,
    );
    const raw = await ctx.http(
      "GET",
      `${API}/b/${ctx.names.bucket}/o?prefix=${encode(prefix)}&maxResults=1000&fields=items(name),nextPageToken`,
    );
    report.check(
      "the first raw page is capped at 1000 and has a next page token",
      (raw.json?.items?.length ?? 0) === 1000 &&
        typeof raw.json?.nextPageToken === "string",
      () => `${raw.json?.items?.length ?? 0} items`,
    );
  } finally {
    const failed = (
      await pool(keys, 32, async (key) =>
        store.delete(key).then(
          () => false,
          () => true,
        ),
      )
    ).filter(Boolean).length;
    report.check(
      "probe objects deleted",
      failed === 0,
      `${failed} left under the probe prefix`,
    );
  }
}

/** V4 signed URL through IAM `signBlob`, when a service account that may read the bucket is named. */
export async function signedUrl(ctx) {
  const { report } = ctx;
  const signerEmail = ctx.flags["signer-sa"];
  if (typeof signerEmail !== "string")
    return report.skip(
      "signed URL",
      "pass --signer-sa <function service account> (the caller needs roles/iam.serviceAccountTokenCreator on it; it needs read access to the bucket). No deployed role presigns today",
    );
  const store = await (ctx.deps.createBlobStore ?? realBlobStore)(ctx, {
    signerEmail,
  });
  const key = `g8-probe/${ctx.config.runId}/signed`;
  try {
    await store.put(key, new TextEncoder().encode("signed-body"));
    const url = await store.presign(key, { method: "GET", expiresInSec: 300 });
    const good = await ctx.http("GET", url, { token: "none" });
    report.check(
      "a V4 signed URL is accepted",
      good.status === 200 && good.text === "signed-body",
      `status ${good.status}`,
    );
    const tampered = await ctx.http(
      "GET",
      url.replace(
        /(X-Goog-Signature=)([0-9a-f])/,
        (_, name, digit) => `${name}${digit === "0" ? "1" : "0"}`,
      ),
      { token: "none" },
    );
    report.check(
      "a tampered signature is rejected",
      tampered.status === 403,
      `status ${tampered.status}`,
    );
  } catch (error) {
    report.fail("signed URL", error instanceof Error ? error.message : "error");
  } finally {
    await store.delete(key).catch(() => undefined);
  }
}

async function run(ctx) {
  const steps = {
    bucket: bucketSettings,
    conditional: conditionalWrite,
    wording: notFoundWording,
    resumable: resumableUpload,
    list: listPaging,
    signed: signedUrl,
  };
  for (const name of String(
    ctx.flags.only ?? Object.keys(steps).join(","),
  ).split(","))
    if (steps[name]) await steps[name](ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
