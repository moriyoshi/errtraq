import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";

const outfile = ".agents-workspace/tmp/m3b2-workers-smoke.mjs";
const build = spawnSync(
  "pnpm",
  [
    "--filter",
    "@moriyoshi/errtraq-cli",
    "exec",
    "esbuild",
    "../../scripts/workers-smoke-entry.ts",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--conditions=development",
    `--outfile=../../${outfile}`,
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) throw new Error("Workers smoke bundle failed");
const seen = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === "/bucket/object" && req.method === "PUT") {
    seen.push("s3");
    res.writeHead(200);
    res.end();
    return;
  }
  if (
    req.url === "/" &&
    req.headers["x-amz-target"] === "AmazonSQS.SendMessageBatch"
  ) {
    seen.push("sqs");
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ Successful: body.Entries.map(({ Id }) => ({ Id })) }),
    );
    return;
  }
  if (
    req.url === "/" &&
    req.headers["x-amz-target"] === "DynamoDB_20120810.PutItem"
  ) {
    seen.push("dynamodb");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  if (
    req.url === "/" &&
    req.headers["x-amz-target"] === "DynamoDB_20120810.GetItem"
  ) {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push("store");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        body.Key.PK.S === "META|schema"
          ? { Item: { projectTimeShards: { N: "4" } } }
          : {},
      ),
    );
    return;
  }
  if (
    req.url === "/" &&
    req.headers["x-amz-target"] === "AmazonSQS.ChangeMessageVisibility"
  ) {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.VisibilityTimeout !== 2) {
      res.writeHead(400);
      res.end();
      return;
    }
    seen.push("visibility");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const endpoint = `http://127.0.0.1:${server.address().port}`;
let mf;
try {
  mf = new Miniflare({
    modules: true,
    scriptPath: outfile,
    compatibilityDate: "2026-01-01",
    bindings: { ENDPOINT: endpoint },
  });
  const response = await mf.dispatchFetch("http://localhost/");
  if (
    response.status !== 200 ||
    (await response.text()) !== "ok" ||
    seen.join(",") !== "s3,sqs,dynamodb,store,store,visibility"
  )
    throw new Error(
      `Workers smoke failed: HTTP ${response.status}; requests ${seen.join(",")}`,
    );
  console.log(
    "PASS workerd executes signed S3, SQS producer and delayed push, and DynamoDB requests against local fake services",
  );
} finally {
  await mf?.dispose();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
