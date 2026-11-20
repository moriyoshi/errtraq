import {
  type Cursor,
  type EventId,
  isProjectId,
  isTimestamp,
  type ProjectId,
  type Timestamp,
  toTimestamp,
} from "./domain.js";
import { parseEnvelope, parseEventPayload } from "./envelope.js";
import { normalizeEventId } from "./normalize.js";
import type { BlobStore, Logger, QueueProducer } from "./ports.js";

/** Re-enqueue durable staged envelopes after volatile queue loss. New keys retain receipt time and message key. */
export async function recoverStagedEnvelopes(
  blobs: BlobStore,
  queue: QueueProducer,
  logger?: Pick<Logger, "warn">,
): Promise<number> {
  let cursor: Cursor | undefined;
  let recovered = 0;
  do {
    const page = await blobs.list("envelopes/", cursor, 100);
    cursor = page.nextCursor ?? undefined;
    for (const blobKey of page.items) {
      const parts = blobKey.split("/");
      const projectId = parts[1];
      if (!projectId || !isProjectId(projectId)) {
        logger?.warn("Invalid staged envelope key", { blobKey });
        continue;
      }
      let receivedAt: string | undefined;
      try {
        receivedAt = decodeURIComponent(parts[2] ?? "");
      } catch {
        receivedAt = undefined;
      }
      let key = normalizeEventId(parts[3]);
      if (!key || !receivedAt || !isTimestamp(receivedAt)) {
        const stream = await blobs.get(blobKey);
        if (!stream) continue;
        const envelope = parseEnvelope(
          new Uint8Array(await new Response(stream).arrayBuffer()),
        );
        const first = envelope.items.find(
          (item) => item.headers.type === "event",
        );
        key =
          normalizeEventId(envelope.headers.event_id) ??
          (first
            ? normalizeEventId(parseEventPayload(first.payload).event_id)
            : null);
        if (!key) {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(blobKey),
          );
          key = Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("") as EventId;
        }
        receivedAt = toTimestamp(new Date());
      }
      await queue.send("ingest", [
        {
          key,
          body: {
            projectId: projectId as ProjectId,
            blobKey,
            receivedAt: receivedAt as Timestamp,
          },
        },
      ]);
      recovered++;
    }
  } while (cursor);
  return recovered;
}
