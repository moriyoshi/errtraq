import { join } from "node:path";
import { fsBlob } from "@errtraq/blob-fs/stack";
import { defineStack } from "@errtraq/core";
import { memoryKv } from "@errtraq/kv-memory/stack";
import { standalone } from "@errtraq/platform-standalone/stack";
import { memoryQueue } from "@errtraq/queue-memory/stack";
import { sqlite } from "@errtraq/store-sql/stack";

const data = process.env.ERRTRAQ_DATA_DIR ?? ".errtraq";
const port =
  process.env.ERRTRAQ_PORT === undefined
    ? 8787
    : Number(process.env.ERRTRAQ_PORT);
export default defineStack({
  name: "local",
  tags: {},
  providers: {},
  platform: standalone({
    port,
    rateLimit: 10000,
    roles: ["ingest", "api", "consumer", "cron"],
    split: [],
    cron: [],
  }),
  store: sqlite({ path: join(data, "events.sqlite") }),
  queue: memoryQueue(),
  blob: fsBlob({ root: join(data, "blobs") }),
  kv: memoryKv(),
});
