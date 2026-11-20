import { fsBlob } from "@errtraq/blob-fs/stack";
import { defineStack, env } from "@errtraq/core";
import { memoryKv } from "@errtraq/kv-memory/stack";
import { standalone } from "@errtraq/platform-standalone/stack";
import { memoryQueue } from "@errtraq/queue-memory/stack";
import { sqlite } from "@errtraq/store-sql/stack";

export default defineStack({
  name: "local",
  providers: {},
  platform: standalone({
    port: env("ERRTRAQ_PORT", { defaultValue: "8787", valueType: "number" }),
    rateLimit: 10000,
    roles: ["ingest", "api", "consumer", "cron"],
    split: [],
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
});
