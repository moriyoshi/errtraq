import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AdapterSelection,
  type Binding,
  type DeploymentTrigger,
  defineStack,
  deriveDeployment,
  type InfraDescriptor,
  out,
  output,
  type PlatformSelection,
  type StackConfig,
  stackValue,
  validateStack,
} from "./index.js";

// Illustrative descriptors only: no AWS adapters or Terraform modules exist here.
const role = z.enum(["ingest", "api", "consumer", "cron"]);
const platform: PlatformSelection = {
  manifest: {
    id: "example-lambda",
    kind: "platform",
    runtime: "node",
    compute: "function",
    configSchema: z.strictObject({
      roles: z.array(role),
      split: z.array(role),
      http: z.array(role),
      settings: z
        .partialRecord(
          role,
          z.object({ timeoutSec: z.number(), memoryMb: z.number().optional() }),
        )
        .optional(),
    }),
    capabilities: {},
    runtimes: ["node"],
    requires: [],
    provides: [],
    authorization: "iam",
    bindingKinds: ["env", "secret"],
    reservedBindings: ["AWS_REGION", "AWS_LAMBDA_*"],
  },
  config: {
    roles: ["ingest", "api", "consumer", "cron"],
    split: ["ingest", "api", "consumer", "cron"],
    http: ["ingest", "api"],
    settings: { consumer: { timeoutSec: 30, memoryMb: 512 } },
  },
  runtimeModule: "example-lambda",
  infra: {
    module: {
      provider: "aws",
      component: "lambda-app",
      outputs: { ingest_url: "string", api_url: "string" },
    },
    inputs: (_config, deployment) => ({
      artifacts: Object.fromEntries(
        deployment.functions.map((fn) => [fn.id, fn.artifact]),
      ),
    }),
    resources: {},
    capabilities: {},
    bindings: [],
  },
};
function resource(
  kind: "store" | "blob" | "kv" | "archive",
  capabilities: string[],
): AdapterSelection {
  const purposes = kind === "blob" ? ["primary", "staging"] : ["primary"];
  return {
    manifest: {
      id: `example-${kind}`,
      kind,
      runtimes: ["node"],
      requires: [],
      configSchema: z.strictObject({}),
      capabilities:
        kind === "store"
          ? {
              textSearch: false,
              recordEvents: false,
              lastSeenRangeOnOtherSort: false,
              deleteStrategy: "explicit",
            }
          : kind === "archive"
            ? { rowDelete: "copy-on-write" }
            : {},
    },
    config: {},
    runtimeModule: `example-${kind}`,
    infra: {
      module: {
        provider: "aws",
        component: kind,
        outputs: { id: "string", policies: { map: { map: "json-document" } } },
      },
      inputs: () => ({ name: stackValue("name") }),
      resources: Object.fromEntries(
        purposes.map((purpose) => [purpose, out("id")]),
      ),
      capabilities: Object.fromEntries(
        capabilities.map((capability) => [
          capability,
          Object.fromEntries(
            purposes.map((purpose) => [
              purpose,
              out("policies", capability, purpose),
            ]),
          ),
        ]),
      ),
      bindings: purposes.map((purpose) => ({
        name: `${kind.toUpperCase()}_${purpose.toUpperCase()}`,
        kind: "env" as const,
        purpose,
        value: out("id"),
      })),
    },
  };
}

// The same descriptor factory selects shared or per-topic physical queues.
function queue(mode: "shared" | "per-topic"): AdapterSelection {
  const keys =
    mode === "shared"
      ? ["shared"]
      : ["ingest", "archive_project", "notifications"];
  const physical =
    mode === "shared"
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
  const bindings: Binding[] = keys.map((key) => ({
    name: `QUEUE_${key.toUpperCase()}`,
    kind: "env",
    purpose: key,
    capabilities: ["produce"],
    value: out("queues", key, "url"),
  }));
  const infra: InfraDescriptor<unknown> = {
    module: {
      provider: "aws",
      component: "sqs",
      outputs: {
        queues: { map: { map: "string" } },
        policies: { map: { map: "json-document" } },
      },
    },
    inputs: () => ({ name: stackValue("name"), region: stackValue("region") }),
    resources: Object.fromEntries(
      keys.map((key) => [key, out("queues", key, "arn")]),
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
    topics: {
      mode,
      routes: {
        ingest: {
          physical: physical.ingest,
          producerBinding: `QUEUE_${physical.ingest.toUpperCase()}`,
        },
        "archive.project": {
          physical: physical["archive.project"],
          producerBinding: `QUEUE_${physical["archive.project"].toUpperCase()}`,
        },
        notifications: {
          physical: physical.notifications,
          producerBinding: `QUEUE_${physical.notifications.toUpperCase()}`,
        },
      },
      settings: Object.fromEntries(
        keys.map((key) => [
          key,
          {
            batchSize: 10,
            maxConcurrency: 4,
            visibilityTimeoutSec: 180,
            dlq: { enabled: true, maxReceiveCount: 5 },
          },
        ]),
      ),
    },
  };
  return {
    manifest: {
      id: "example-sqs",
      kind: "queue",
      configSchema: z.strictObject({}),
      runtimes: ["node"],
      requires: [],
      capabilities: {
        delivery: "push",
        grouping: "none",
        maxBytes: 262144,
        delay: true,
        dlq: true,
        visibilityTimeout: true,
      },
    },
    config: {},
    runtimeModule: "example-sqs",
    infra,
  };
}

// These are the two worked stacks quoted by INFRA_MODEL.md.
function exampleStack(mode: "shared" | "per-topic"): StackConfig {
  return {
    name: "example",
    providers: {
      aws: {
        source: "hashicorp/aws",
        version: "~> 6",
        region: "us-east-1",
        tags: { app: "errtraq" },
      },
    },
    platform,
    store: resource("store", [
      "key-read",
      "project-read",
      "read",
      "write",
      "delete",
      "metadata-delete",
    ]),
    queue: queue(mode),
    blob: resource("blob", ["read", "write", "delete", "list"]),
    kv: resource("kv", ["read", "write"]),
    archive: resource("archive", ["read", "write", "delete"]),
    outputs: {
      ingest_url: output("platform", "ingest_url"),
      api_url: output("platform", "api_url"),
    },
  };
}
const shared = defineStack(exampleStack("shared"));
const perTopic = defineStack({
  ...exampleStack("per-topic"),
  features: { notifications: true },
});

describe("documented infrastructure examples", () => {
  it("validates a shared AWS queue and one trigger", () => {
    expect(validateStack(shared)).toEqual([]);
    expect(
      deriveDeployment(shared).triggers.filter((t) => t.kind === "queue"),
    ).toHaveLength(1);
  });
  it("validates three per-topic AWS queues with scoped policies", () => {
    expect(validateStack(perTopic)).toEqual([]);
    const view = deriveDeployment(perTopic);
    expect(view.triggers.filter((t) => t.kind === "queue")).toHaveLength(3);
    const ingest = view.functions.find((fn) => fn.id === "ingest");
    expect(
      ingest?.policies
        .filter((g) => g.selection === "queue")
        .map((g) => g.policyOutput),
    ).toEqual([output("queue", "policies", "produce", "ingest")]);
    const consumer = view.functions.find((fn) => fn.id === "consumer");
    expect(
      consumer?.policies.filter(
        (g) => g.selection === "queue" && g.capability === "consume",
      ),
    ).toHaveLength(3);
  });
});

// Types-only sketch: real platform bindings and their runtime adapters are future work.
type CloudflareFit = {
  platform: PlatformSelection;
  bindings: {
    d1: Binding & { kind: "platform"; platformType: "d1" };
    queues: Binding & { kind: "platform"; platformType: "queue-producer" };
    r2: Binding & { kind: "platform"; platformType: "r2" };
    kv: Binding & { kind: "platform"; platformType: "kv" };
  };
  queueConsumer: Extract<DeploymentTrigger, { kind: "queue" }>;
  cron: Extract<DeploymentTrigger, { kind: "cron" }>;
};
const cloudflareKinds: {
  [K in keyof CloudflareFit["bindings"]]: Pick<
    CloudflareFit["bindings"][K],
    "kind" | "platformType"
  >;
} = {
  d1: { kind: "platform", platformType: "d1" },
  queues: { kind: "platform", platformType: "queue-producer" },
  r2: { kind: "platform", platformType: "r2" },
  kv: { kind: "platform", platformType: "kv" },
};
it("keeps the Cloudflare binding sketch type-only", () => {
  const kinds = Object.values(cloudflareKinds).map((value) => value.kind);
  expect(kinds).toEqual(["platform", "platform", "platform", "platform"]);
});
