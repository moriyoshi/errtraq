import { assert, check, client, element, unique } from "./client.mjs";
export async function probeS3(endpoint) {
  const c = client(endpoint),
    bucket = unique(),
    results = {};
  const base = `/${bucket}`;
  try {
    await c.request("s3", base, { method: "PUT" });
    await check(results, "put/get/head", async () => {
      await c.request("s3", `${base}/alpha`, { method: "PUT", body: "abcdef" });
      assert.equal((await c.request("s3", `${base}/alpha`)).text, "abcdef");
      const h = await c.request("s3", `${base}/alpha`, { method: "HEAD" });
      assert.equal(h.headers.get("content-length"), "6");
    });
    await check(results, "range", async () => {
      const r = await c.request("s3", `${base}/alpha`, {
        headers: { range: "bytes=1-3" },
      });
      assert.equal(r.status, 206);
      assert.equal(r.text, "bcd");
    });
    await check(results, "list-v2-pagination", async () => {
      await c.request("s3", `${base}/beta`, { method: "PUT", body: "x" });
      const a = await c.request("s3", `${base}?list-type=2&max-keys=1`);
      const token = element(a.text, "NextContinuationToken");
      assert.ok(token, `missing continuation: ${a.text}`);
      const b = await c.request(
        "s3",
        `${base}?list-type=2&max-keys=1&continuation-token=${encodeURIComponent(token)}`,
      );
      assert.notEqual(element(a.text, "Key"), element(b.text, "Key"));
    });
    await check(results, "utf8-key-list", async () => {
      const key = "utf8/～";
      await c.request("s3", `${base}/utf8/${encodeURIComponent("～")}`, {
        method: "PUT",
        body: "x",
      });
      const result = await c.request(
        "s3",
        `${base}?list-type=2&prefix=utf8%2F`,
      );
      const actual = element(result.text, "Key");
      if (actual === key) return;
      const corrupted = `utf8/${Array.from(new TextEncoder().encode("～"), (byte) => String.fromCharCode(byte)).join("")}`;
      assert.equal(actual, corrupted, "Unexpected UTF-8 probe failure");
      throw new Error("S3_UTF8_PERCENT_DECODER_GAP");
    });
    await check(results, "conditional-put", async () => {
      await c.request("s3", `${base}/conditional`, {
        method: "PUT",
        headers: { "if-none-match": "*" },
        body: "first",
      });
      let rejected = false;
      try {
        await c.request("s3", `${base}/conditional`, {
          method: "PUT",
          headers: { "if-none-match": "*" },
          body: "second",
        });
      } catch (e) {
        rejected = / 412:/.test(String(e));
      }
      assert.ok(
        rejected,
        "duplicate conditional put was not rejected with 412",
      );
      assert.equal(
        (await c.request("s3", `${base}/conditional`)).text,
        "first",
      );
    });
    await check(results, "multipart", async () => {
      const begin = await c.request("s3", `${base}/multipart?uploads`, {
        method: "POST",
      });
      const upload = element(begin.text, "UploadId");
      assert.ok(upload);
      const part = await c.request(
        "s3",
        `${base}/multipart?partNumber=1&uploadId=${encodeURIComponent(upload)}`,
        { method: "PUT", body: "multipart" },
      );
      const etag = part.headers.get("etag");
      assert.ok(etag);
      await c.request(
        "s3",
        `${base}/multipart?uploadId=${encodeURIComponent(upload)}`,
        {
          method: "POST",
          body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
        },
      );
      assert.equal(
        (await c.request("s3", `${base}/multipart`)).text,
        "multipart",
      );
    });
    await check(results, "delete", async () => {
      await c.request("s3", `${base}/alpha`, { method: "DELETE" });
      await assert.rejects(() => c.request("s3", `${base}/alpha`), / 404:/);
    });
  } finally {
    for (const key of [
      "alpha",
      "beta",
      "conditional",
      "multipart",
      `utf8/${encodeURIComponent("～")}`,
    ])
      await c
        .request("s3", `${base}/${key}`, { method: "DELETE" })
        .catch(() => {});
    await c.request("s3", base, { method: "DELETE" }).catch(() => {});
  }
  return results;
}
