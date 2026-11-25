// Runs inside the runner container: creates the bucket in winterbaume, bootstraps Lakekeeper
// and creates the warehouse (sts-enabled false, path-style, s3-compat flavor).
// Prints one JSON object on the last stdout line: { ok, status, body, ... }.
const WB = process.env.WINTERBAUME_URL ?? "http://winterbaume:5555";
const LK = process.env.LAKEKEEPER_URL ?? "http://lakekeeper:8181";
export const BUCKET = "errtraq-archive";
export const WAREHOUSE = "errtraq";

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// Path-style bucket creation; winterbaume does not verify the signature.
// The fake SigV4 header only carries the service name so winterbaume routes to S3.
const mk = await fetch(`${WB}/${BUCKET}`, {
  method: "PUT",
  headers: {
    authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`,
  },
});
const out = { bucket: { status: mk.status } };

out.bootstrap = await json("POST", `${LK}/management/v1/bootstrap`, {
  "accept-terms-of-use": true,
});
out.info = await json("GET", `${LK}/management/v1/info`);

out.warehouse = await json("POST", `${LK}/management/v1/warehouse`, {
  "warehouse-name": WAREHOUSE,
  "storage-profile": {
    type: "s3",
    bucket: BUCKET,
    "key-prefix": "warehouse",
    region: "us-east-1",
    endpoint: WB,
    "path-style-access": true,
    flavor: "s3-compat",
    "sts-enabled": false,
  },
  "storage-credential": {
    type: "s3",
    "credential-type": "access-key",
    "aws-access-key-id": "test",
    "aws-secret-access-key": "test",
  },
});
out.ok = out.warehouse.status >= 200 && out.warehouse.status < 300;
console.log(JSON.stringify(out));
