import {
  type AdapterManifest,
  type AdapterSelection,
  type Binding,
  type InfraDescriptor,
  out,
  type RoutedTopic,
  stackValue,
  type TopicMapping,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";
import { PUBSUB_MAX_BYTES } from "./constants.js";

export { PUBSUB_MAX_BYTES } from "./constants.js";

const resourceId = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const configSchema = z
  .strictObject({
    /** Required: the GCP project that owns the topics. Never defaulted. */
    projectId: z.string().regex(resourceId, "Invalid GCP project id"),
    /**
     * Required, never defaulted (owner decision D7). Selects the regional
     * endpoint used for ordered publishes and must match the subscriptions.
     */
    region: z.string().regex(/^[a-z]+-[a-z]+[0-9]+$/, "Invalid GCP region"),
    requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
    overallTimeoutMs: z.number().int().min(1).max(300000).optional(),
    mode: z.enum(["shared", "per-topic"]).default("shared"),
    /** Push ack deadline; validation requires six consumer timeouts. */
    ackDeadlineSec: z.number().int().min(10).max(600).default(180),
    minBackoffSec: z.number().int().min(0).max(600).default(10),
    maxBackoffSec: z.number().int().min(0).max(600).default(600),
    dlq: z.boolean().default(true),
    /** Approximate; Pub/Sub accepts 5 to 100. */
    maxDeliveryAttempts: z.number().int().min(5).max(100).default(5),
    /**
     * Push authentication. "verifier" (default) requires an injected
     * `verifyPush` and rejects unauthenticated pushes. "platform" means the
     * hosting platform authenticates the request before it reaches the
     * adapter (Cloud Run run.invoker with OIDC). "none" accepts every request
     * and exists for tests and emulators only.
     */
    pushAuth: z.enum(["verifier", "platform", "none"]).default("verifier"),
    /** Endpoint override for the Pub/Sub emulator; never set in production. */
    endpoint: z.url().optional(),
  })
  .refine((config) => config.minBackoffSec <= config.maxBackoffSec, {
    message: "minBackoffSec must not exceed maxBackoffSec",
    path: ["minBackoffSec"],
  });
export type Config = z.input<typeof configSchema>;
type ResolvedConfig = z.output<typeof configSchema>;
export const manifest: AdapterManifest = {
  id: "queue-pubsub",
  kind: "queue",
  configSchema,
  runtimes: ["node", "workers"],
  requires: [],
  capabilities: {
    delivery: "push",
    maxBytes: PUBSUB_MAX_BYTES,
    // A retry's delaySec cannot be honoured per message: the subscription retry
    // policy and push backoff decide. Producer delaySec is rejected.
    delay: false,
    dlq: true,
    // A push subscription's ack deadline is the visibility analogue.
    visibilityTimeout: true,
    // Largest push ack deadline (seconds); with the six-times rule a consumer timeout is at most 100 s.
    maxVisibilityTimeoutSec: 600,
    grouping: "per-key-serial",
  },
};
function descriptor(config: ResolvedConfig): InfraDescriptor<Config> {
  const physical: Record<
    Exclude<RoutedTopic, "record">,
    string
  > = config.mode === "shared"
    ? {
        ingest: "shared",
        "archive.project": "shared",
        notifications: "shared",
      }
    : {
        ingest: "ingest",
        "archive.project": "archive_project",
        notifications: "notifications",
      };
  const keys = [...new Set([...Object.values(physical), "record"])];
  const binding = (key: string) => `ERRTRAQ_QUEUE_${key.toUpperCase()}_TOPIC`;
  const bindings: Binding[] = keys.map((key) => ({
    name: binding(key),
    kind: "env",
    purpose: key,
    capabilities: ["produce"],
    // The full topic resource name, projects/<project>/topics/<topic>.
    value: out("queues", key, "topic"),
  }));
  const topics: TopicMapping = {
    mode: config.mode,
    routes: {
      ingest: {
        physical: physical.ingest,
        producerBinding: binding(physical.ingest),
      },
      "archive.project": {
        physical: physical["archive.project"],
        producerBinding: binding(physical["archive.project"]),
      },
      notifications: {
        physical: physical.notifications,
        producerBinding: binding(physical.notifications),
      },
      record: {
        physical: "record",
        producerBinding: binding("record"),
        grouping: "per-key-serial",
      },
    },
    settings: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          // One message per push request: batchSize is not a setting.
          visibilityTimeoutSec: config.ackDeadlineSec,
          dlq:
            config.dlq || key === "record"
              ? { enabled: true, maxReceiveCount: config.maxDeliveryAttempts }
              : { enabled: false },
        },
      ]),
    ),
  };
  return {
    // TODO(G6): infra/modules/google/pubsub does not exist yet; this descriptor is
    // the contract the HCL module must satisfy. Subscriptions live in the
    // platform module (GCP_PLAN 5.3), so the module outputs topics only.
    module: {
      provider: "google",
      component: "pubsub",
      outputs: {
        queues: { map: { map: "string" } },
        policies: { map: { map: "json-document" } },
      },
    },
    inputs: (_config, deployment) => ({
      name: stackValue("name"),
      project_id: config.projectId,
      region: config.region,
      physical_queues: Object.fromEntries(
        [
          ...new Set(
            deployment.triggers.flatMap((trigger) =>
              trigger.kind === "queue" ? [trigger.physical] : [],
            ),
          ),
        ].map((key) => [
          key,
          {
            ordered: key === "record",
            ack_deadline_sec: config.ackDeadlineSec,
            min_backoff_sec: config.minBackoffSec,
            max_backoff_sec: config.maxBackoffSec,
            dlq_enabled: config.dlq || key === "record",
            max_delivery_attempts: config.maxDeliveryAttempts,
          },
        ]),
      ),
    }),
    // The full push subscription resource names. The pubsub module only reserves the names
    // (`projects/<project>/subscriptions/<stack>-<physical>`, no resource); the platform module
    // creates the subscriptions under exactly these names, which avoids a module cycle (the
    // subscription needs the function URL, the function needs the name). The platform delivers
    // each name as the `ERRTRAQ_QUEUE_SOURCE_<PHYSICAL>` event-source binding, and a push body's
    // `subscription` field is matched against it.
    resources: Object.fromEntries(
      keys.map((key) => [key, out("queues", key, "subscription")]),
    ),
    capabilities: Object.fromEntries(
      ["produce", "consume"].map((capability) => [
        capability,
        Object.fromEntries(
          keys.map((key) => [key, out("policies", capability, key)]),
        ),
      ]),
    ),
    bindings,
    topics,
  };
}
/** Default descriptor; the helper specializes it to the chosen config. */
export const infra: InfraDescriptor<Config> = descriptor(
  configSchema.parse({ projectId: "example-project", region: "us-central1" }),
);
export function pubsubQueue(config: Config): AdapterSelection<Config> {
  const parsed = configSchema.parse(config);
  return {
    manifest,
    infra: descriptor(parsed),
    config: parsed,
    runtimeModule: "@moriyoshi/errtraq-queue-pubsub/runtime",
  };
}
