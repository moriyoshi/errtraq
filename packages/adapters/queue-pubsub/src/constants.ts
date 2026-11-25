/**
 * Pub/Sub limits, https://docs.cloud.google.com/pubsub/quotas (fetched 2026-11-26):
 * message data 10 MB, 100 attributes (key 256 bytes, value 1024 bytes), publish
 * request 10 MB and 1,000 messages.
 */
export const PUBSUB_MAX_REQUEST_BYTES = 10_000_000;
export const PUBSUB_MAX_REQUEST_MESSAGES = 1000;
/** Fixed JSON overhead of one message entry (attributes, orderingKey, punctuation). */
export const PUBSUB_ENTRY_OVERHEAD_BYTES = 1024;
/**
 * The REST publish request carries the data base64 encoded (4/3 inflation) and
 * is itself capped at 10 MB, so the usable message size is the request limit
 * less envelope overhead, times 3/4, not the 10 MB data limit.
 */
export const PUBSUB_MAX_BYTES =
  Math.floor((PUBSUB_MAX_REQUEST_BYTES - 2 * PUBSUB_ENTRY_OVERHEAD_BYTES) / 4) *
  3;
/** Ordering key limit assumed from the GCP plan (1 KB); longer keys are hashed. */
export const PUBSUB_MAX_ORDERING_KEY_BYTES = 1024;
export const PUBSUB_MAX_ATTRIBUTE_VALUE_BYTES = 1024;
export const TOPIC_ATTRIBUTE = "errtraq-topic";
export const KEY_ATTRIBUTE = "errtraq-key";
