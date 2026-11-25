import { icebergArchive } from "@moriyoshi/errtraq-archive-iceberg/stack";
import { fsBlob } from "@moriyoshi/errtraq-blob-fs/stack";
import { defineStack, env } from "@moriyoshi/errtraq-core";
import { memoryKv } from "@moriyoshi/errtraq-kv-memory/stack";
import { standalone } from "@moriyoshi/errtraq-platform-standalone/stack";
import { memoryQueue } from "@moriyoshi/errtraq-queue-memory/stack";
import { sqlite } from "@moriyoshi/errtraq-store-sql/stack";

// The local archive environment: sqlite active store, Lakekeeper (REST catalog) and winterbaume
// (S3 emulator, path style) from docker/archive/compose.yaml with compose.ports.yaml, and the
// DuckDB engine. The S3 credentials are read from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in
// the environment (winterbaume accepts any values). The archive timers are short so a local run
// archives within seconds; set a project's retentionDays to move the hot-tier cutoff.
export default defineStack({
  name: "local-archive",
  providers: {},
  platform: standalone({
    host: env("ERRTRAQ_HOST", { defaultValue: "127.0.0.1" }),
    port: env("ERRTRAQ_PORT", { defaultValue: "8787", valueType: "number" }),
    tokenDirectory: env("ERRTRAQ_DATA_DIR", { defaultValue: ".errtraq" }),
    rateLimit: 10000,
    roles: ["ingest", "api", "consumer", "cron"],
    split: [],
    http: ["ingest", "api"],
    cronIntervalSec: { "archive-planner": 5, retention: 30 },
  }),
  store: sqlite({
    path: env("ERRTRAQ_DATA_DIR", {
      defaultValue: ".errtraq",
      suffix: "/events.sqlite",
    }),
  }),
  queue: memoryQueue(),
  blob: fsBlob({
    root: env("ERRTRAQ_DATA_DIR", {
      defaultValue: ".errtraq",
      suffix: "/blobs",
    }),
  }),
  kv: memoryKv(),
  archive: icebergArchive({
    catalog: { uri: "http://127.0.0.1:18181/catalog", warehouse: "errtraq" },
    namespace: "errtraq",
    engine: {
      formatVersion: 3,
      s3: {
        endpoint: "127.0.0.1:15555",
        urlStyle: "path",
        useSsl: false,
        region: "us-east-1",
      },
    },
  }),
});
