import {
  type ApiTokenId,
  bootstrapProject,
  ConsumerService,
  type Delivery,
  type EventId,
  groupEvent,
  hashApiToken,
  IngestService,
  type Logger,
  type Message,
  type ProjectId,
  RecordHandler,
  type SymbolicationLimits,
  sha1Hex,
} from "@moriyoshi/errtraq-core";
import { createApiApp, createIngestApp } from "@moriyoshi/errtraq-http";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryBlobStore, MemoryKV, MemoryQueue } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const DEBUG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const SCRIPT = "https://example.com/static/app.min.js";

// A source map is built by hand so the test needs no bundler: one generated line, base64 VLQ.
const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest) digit |= 32;
    out += BASE64[digit];
  } while (rest);
  return out;
}
interface Segment {
  col: number;
  line: number;
  srcCol: number;
  name: number;
}
function mappings(segments: Segment[]): string {
  let col = 0;
  let line = 0;
  let srcCol = 0;
  let name = 0;
  return segments
    .map((s) => {
      const out =
        vlq(s.col - col) +
        vlq(0) +
        vlq(s.line - line) +
        vlq(s.srcCol - srcCol) +
        vlq(s.name - name);
      col = s.col;
      line = s.line;
      srcCol = s.srcCol;
      name = s.name;
      return out;
    })
    .join(",");
}
const ORIGINAL = [
  "function handler(user) {",
  "  return user.name.length;",
  "}",
  "export function run() {",
  "  return handler(null);",
  "}",
].join("\n");
const MINIFIED =
  "function a(b){return b.name.length}function c(){return a(null)}c();";
const AT_NAME = MINIFIED.indexOf("b.name");
const AT_CALL = MINIFIED.indexOf("a(null)");
const sourceMap = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 3,
    file: "app.min.js",
    sources: ["webpack://app/./src/app.ts"],
    sourcesContent: [ORIGINAL],
    names: ["user", "handler"],
    mappings: mappings([
      { col: AT_NAME, line: 1, srcCol: 9, name: 0 },
      { col: AT_CALL, line: 4, srcCol: 9, name: 1 },
    ]),
    ...extra,
  });

function bundle(
  options: {
    debugId?: string;
    map?: string | null;
    mapDebugId?: boolean;
    sourcemapHeader?: boolean;
  } = {},
): Uint8Array {
  const id = options.debugId ?? DEBUG_ID;
  const files: Record<string, unknown> = {
    "files/_/_/static/app.min.js": {
      type: "minified_source",
      url: "~/static/app.min.js",
      headers: {
        "debug-id": id,
        ...(options.sourcemapHeader === false
          ? {}
          : { sourcemap: "app.min.js.map" }),
      },
    },
  };
  const members: Record<string, Uint8Array> = {
    "files/_/_/static/app.min.js": strToU8(MINIFIED),
  };
  if (options.map !== null) {
    files["files/_/_/static/app.min.js.map"] = {
      type: "source_map",
      url: "~/static/app.min.js.map",
      headers: options.mapDebugId === false ? {} : { "debug-id": id },
    };
    members["files/_/_/static/app.min.js.map"] = strToU8(
      options.map ?? sourceMap(),
    );
  }
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ files })),
    ...members,
  });
}

const frame = (colno: number, extra: Record<string, unknown> = {}) => ({
  abs_path: `${SCRIPT}?v=1`,
  filename: "/static/app.min.js",
  function: "?",
  lineno: 1,
  colno: colno + 1,
  in_app: true,
  ...extra,
});
const errorEvent = (
  id: string,
  frames: unknown[] = [frame(AT_CALL, { function: "c" }), frame(AT_NAME)],
  images: unknown[] = [
    { type: "sourcemap", code_file: SCRIPT, debug_id: DEBUG_ID },
  ],
) => ({
  event_id: id,
  platform: "javascript",
  exception: {
    values: [{ type: "TypeError", value: "boom", stacktrace: { frames } }],
  },
  debug_meta: { images },
});
const envelope = (event: { event_id: string }) =>
  `${JSON.stringify({ event_id: event.event_id })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
let counter = 0;
const nextId = () => (++counter).toString(16).padStart(32, "0");

async function setup(
  options: {
    limits?: Partial<SymbolicationLimits>;
    recordMode?: "direct" | "grouped";
  } = {},
) {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const kv = new MemoryKV(clock);
  const blobs = new MemoryBlobStore();
  const queue = new MemoryQueue(clock);
  const ids = new DeterministicIdGen();
  const a = await bootstrapProject({
    store,
    kv,
    ids,
    orgSlug: "org",
    projectSlug: "project",
  });
  const b = await bootstrapProject({
    store,
    kv,
    ids,
    orgSlug: "other",
    projectSlug: "theirs",
  });
  for (const [id, org, secret] of [
    ["ta", a.org.id, "secret"],
    ["tb", b.org.id, "other"],
  ] as const)
    await store.projects.putToken({
      id: id as ApiTokenId,
      orgId: org,
      tokenHash: await hashApiToken(secret),
      scopes: ["event:read", "event:write"],
    });
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const sent: Message[] = [];
  const producer = {
    send: async (
      topic: string,
      messages: Message[],
      opts?: { delaySec?: number },
    ) => {
      if (topic === "ingest") sent.push(...structuredClone(messages));
      await queue.producer.send(topic, messages, opts);
    },
  };
  const api = createApiApp({ store, clock, blobs, ids });
  const upload = async (
    data: Uint8Array,
    org: "org" | "other" = "org",
    project: "project" | "theirs" = "project",
  ) => {
    const token = org === "org" ? "secret" : "other";
    const form = new FormData();
    form.append("file", new File([data as BlobPart], await sha1Hex(data)));
    const headers = { authorization: `Bearer ${token}` };
    await api.request(
      `http://errtraq.test/api/0/organizations/${org}/chunk-upload/`,
      { method: "POST", body: form, headers },
    );
    const res = await api.request(
      `http://errtraq.test/api/0/organizations/${org}/artifactbundle/assemble/`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          checksum: await sha1Hex(data),
          chunks: [await sha1Hex(data)],
          projects: [project],
        }),
      },
    );
    expect(await res.json()).toMatchObject({ state: "ok" });
  };
  const consumer = (
    extra: Partial<ConstructorParameters<typeof ConsumerService>[0]> = {},
  ) =>
    new ConsumerService({
      store,
      blobs,
      kv,
      logger,
      symbolicationLimits: options.limits,
      recordMode: options.recordMode,
      queue,
      ...extra,
    });
  const ingest = createIngestApp(
    new IngestService({
      store,
      blobs,
      queue: producer,
      kv,
      clock,
      logger,
      rateLimit: null,
    }),
  );
  const projects = { a, b };
  /** Send one event through ingest and process it with the given consumer. */
  const process = async (
    event: { event_id: string },
    who: "a" | "b" = "a",
    svc = consumer(),
    attempt = 1,
  ) => {
    const p = projects[who];
    sent.length = 0;
    const res = await ingest.request(
      `/api/${p.project.id}/envelope/?sentry_key=${p.key.publicKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body: envelope(event),
      },
    );
    expect(res.status).toBe(200);
    const message = sent[0];
    if (!message) throw new Error("no claim");
    const delivery: Delivery = { id: "d", topic: "ingest", attempt, message };
    const result = await svc.handle([delivery]);
    return { result, projectId: p.project.id as ProjectId, delivery };
  };
  const stored = async (projectId: ProjectId, id: string) => {
    const event = await store.events.get(projectId, id as EventId);
    if (!event) throw new Error("event not stored");
    return event;
  };
  return {
    store,
    blobs,
    queue,
    upload,
    process,
    stored,
    consumer,
    logger,
    api,
  };
}
type Payload = ReturnType<typeof errorEvent>;
const framesOf = (payload: unknown) =>
  (payload as Payload).exception.values[0]?.stacktrace.frames as Record<
    string,
    unknown
  >[];

describe("JavaScript symbolication in the consumer", () => {
  it("maps frames, names, context and keeps the minified location", async () => {
    const t = await setup();
    await t.upload(bundle());
    const id = nextId();
    const { projectId } = await t.process(errorEvent(id));
    const event = await t.stored(projectId, id);
    const [outer, inner] = framesOf(event.payload);
    expect(inner).toMatchObject({
      abs_path: "webpack://app/src/app.ts",
      filename: "src/app.ts",
      lineno: 2,
      colno: 10,
      // The caller's token names the identifier it called: the function of the next frame.
      function: "handler",
      context_line: "  return user.name.length;",
      pre_context: ["function handler(user) {"],
      post_context: [
        "}",
        "export function run() {",
        "  return handler(null);",
        "}",
      ],
      in_app: true,
      data: {
        symbolicated: true,
        sourcemap: DEBUG_ID,
        minified: {
          abs_path: `${SCRIPT}?v=1`,
          filename: "/static/app.min.js",
          lineno: 1,
          colno: AT_NAME + 1,
        },
      },
    });
    expect(outer).toMatchObject({
      filename: "src/app.ts",
      lineno: 5,
      colno: 10,
      function: "c",
      context_line: "  return handler(null);",
    });
    expect((event.payload as Record<string, unknown>).errors).toBeUndefined();
    // The API serves the rewritten frames.
    const served = await t.api.request(
      `http://errtraq.test/api/0/projects/org/project/events/${id}`,
      { headers: { authorization: "Bearer secret" } },
    );
    expect(served.status).toBe(200);
    expect(JSON.stringify(await served.json())).toContain(
      '"filename":"src/app.ts"',
    );
  });

  it("finds the map through the minified file's sourcemap header", async () => {
    const t = await setup();
    await t.upload(bundle({ mapDebugId: false }));
    const id = nextId();
    const { projectId } = await t.process(errorEvent(id));
    expect(framesOf((await t.stored(projectId, id)).payload)[1]).toMatchObject({
      lineno: 2,
    });
  });

  it("keeps in_app false for node_modules sources and drops stale module and context", async () => {
    const t = await setup();
    await t.upload(
      bundle({
        map: sourceMap({
          sources: ["webpack://app/./node_modules/lib/index.js"],
        }),
      }),
    );
    const id = nextId();
    const { projectId } = await t.process(
      errorEvent(id, [
        frame(AT_NAME, {
          module: "app.min",
          context_line: "minified",
          pre_context: ["x"],
        }),
      ]),
    );
    const [only] = framesOf((await t.stored(projectId, id)).payload);
    expect(only).toMatchObject({
      in_app: false,
      filename: "node_modules/lib/index.js",
    });
    expect(only).not.toHaveProperty("module");
    expect(only?.context_line).toBe("  return user.name.length;");
  });

  it("omits context when the map has no sourcesContent", async () => {
    const t = await setup();
    await t.upload(bundle({ map: sourceMap({ sourcesContent: undefined }) }));
    const id = nextId();
    const { projectId } = await t.process(
      errorEvent(id, [frame(AT_NAME, { context_line: "minified" })]),
    );
    const [only] = framesOf((await t.stored(projectId, id)).payload);
    expect(only).toMatchObject({ lineno: 2 });
    expect(only).not.toHaveProperty("context_line");
  });

  it("records a missing bundle and keeps the raw frames", async () => {
    const t = await setup();
    const id = nextId();
    const { result, projectId } = await t.process(errorEvent(id));
    expect(result).toEqual([{ deliveryId: "d", action: "ack" }]);
    const event = await t.stored(projectId, id);
    expect(framesOf(event.payload)[1]).toMatchObject({
      colno: AT_NAME + 1,
      function: "?",
    });
    expect(framesOf(event.payload)[1]).not.toHaveProperty("data");
    expect((event.payload as Record<string, unknown>).errors).toEqual([
      expect.objectContaining({ type: "js_no_source", debug_id: DEBUG_ID }),
    ]);
  });

  it("records a bundle without a source map for the debug ID", async () => {
    const t = await setup();
    await t.upload(bundle({ map: null, sourcemapHeader: false }));
    const id = nextId();
    const { projectId } = await t.process(errorEvent(id));
    const event = await t.stored(projectId, id);
    expect((event.payload as Record<string, unknown>).errors).toEqual([
      expect.objectContaining({ type: "js_no_source" }),
    ]);
  });

  it("records a corrupt source map as invalid and still stores the event", async () => {
    const t = await setup();
    await t.upload(bundle({ map: "{not json" }));
    const id = nextId();
    const { result, projectId } = await t.process(errorEvent(id));
    expect(result[0]?.action).toBe("ack");
    const event = await t.stored(projectId, id);
    expect((event.payload as Record<string, unknown>).errors).toEqual([
      expect.objectContaining({ type: "js_invalid_source" }),
    ]);
    expect(framesOf(event.payload)[1]).not.toHaveProperty("data");
  });

  it("does not use a debug ID owned by another project", async () => {
    const t = await setup();
    // The other project's organization owns the bundle; project A must not see it.
    await t.upload(bundle(), "other", "theirs");
    const id = nextId();
    const { projectId } = await t.process(errorEvent(id), "a");
    const event = await t.stored(projectId, id);
    expect(framesOf(event.payload)[1]).not.toHaveProperty("data");
    expect((event.payload as Record<string, unknown>).errors).toEqual([
      expect.objectContaining({ type: "js_no_source" }),
    ]);
    // The owner symbolicates the same stack.
    const owned = nextId();
    const mine = await t.process(errorEvent(owned), "b");
    expect(
      framesOf((await t.stored(mine.projectId, owned)).payload)[1],
    ).toMatchObject({ lineno: 2 });
  });

  it("enforces the per-event frame and bundle limits", async () => {
    const t = await setup({ limits: { maxFramesPerEvent: 1 } });
    await t.upload(bundle());
    const id = nextId();
    const { projectId } = await t.process(errorEvent(id));
    const event = await t.stored(projectId, id);
    const [first, second] = framesOf(event.payload);
    expect(first).toMatchObject({ lineno: 5 });
    expect(second).not.toHaveProperty("data");
    expect((event.payload as Record<string, unknown>).errors).toEqual([
      expect.objectContaining({ type: "js_symbolication_limit" }),
    ]);

    const u = await setup({ limits: { maxBundlesPerEvent: 1 } });
    await u.upload(bundle());
    await u.upload(bundle({ debugId: OTHER_ID }));
    const other = "https://example.com/static/other.min.js";
    const two = nextId();
    const result = await u.process(
      errorEvent(
        two,
        [frame(AT_CALL), frame(AT_NAME, { abs_path: other })],
        [
          { type: "sourcemap", code_file: SCRIPT, debug_id: DEBUG_ID },
          { type: "sourcemap", code_file: other, debug_id: OTHER_ID },
        ],
      ),
    );
    const capped = await u.stored(result.projectId, two);
    const [x, y] = framesOf(capped.payload);
    expect(x).toHaveProperty("data");
    expect(y).not.toHaveProperty("data");
    expect((capped.payload as Record<string, unknown>).errors).toEqual([
      expect.objectContaining({ type: "js_symbolication_limit" }),
    ]);
  });

  it("refuses oversized bundles and maps", async () => {
    for (const limits of [{ maxBundleBytes: 100 }, { maxMapBytes: 10 }]) {
      const t = await setup({ limits });
      await t.upload(bundle());
      const id = nextId();
      const { projectId } = await t.process(errorEvent(id));
      const event = await t.stored(projectId, id);
      expect((event.payload as Record<string, unknown>).errors).toEqual([
        expect.objectContaining({ type: "js_invalid_source" }),
      ]);
      expect(framesOf(event.payload)[1]).not.toHaveProperty("data");
    }
  });

  it("parses each map once per invocation and caches negative results", async () => {
    const t = await setup();
    await t.upload(bundle());
    const lookup = vi.spyOn(t.store.releases, "findBundleByDebugId");
    const consumer = t.consumer();
    const ids = [nextId(), nextId(), nextId()];
    // Three events in one batch share one lookup.
    const deliveries: Delivery[] = [];
    for (const id of ids) {
      const r = await t.process(errorEvent(id), "a", {
        handle: async (batch: Delivery[]) => {
          deliveries.push(...batch);
          return [{ deliveryId: "d", action: "ack" as const }];
        },
      } as ConsumerService);
      expect(r.result).toHaveLength(1);
    }
    const results = await consumer.handle(
      deliveries.map((d, i) => ({ ...d, id: `d${i}` })),
    );
    expect(results.map((r) => r.action)).toEqual(["ack", "ack", "ack"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("retries a transient lookup failure on every attempt instead of grouping by raw frames", async () => {
    const t = await setup();
    const failing = t.consumer({
      releases: {
        findBundleByDebugId: async () => {
          throw new Error("store down");
        },
      },
    });
    for (const attempt of [1, 2, 3, 7]) {
      const id = nextId();
      const { result, projectId } = await t.process(
        errorEvent(id),
        "a",
        failing,
        attempt,
      );
      expect(result).toEqual([{ deliveryId: "d", action: "retry" }]);
      expect(await t.store.events.get(projectId, id as EventId)).toBeNull();
    }
  });

  describe.each(["direct", "grouped"] as const)(
    "one event across attempts that disagree (%s mode)",
    (recordMode) => {
      /** Everything the grouped consumer sent to the record queue, replayed through the handler. */
      const drain = async (
        t: Awaited<ReturnType<typeof setup>>,
        sent: Delivery[],
      ) => {
        if (recordMode !== "grouped") return;
        const handler = new RecordHandler({
          store: t.store,
          blobs: t.blobs,
          logger: t.logger,
        });
        const results = await handler.handle(sent);
        expect(results.every((r) => r.action === "ack")).toBe(true);
      };
      const spyRecords = (t: Awaited<ReturnType<typeof setup>>) => {
        const records: Delivery[] = [];
        const send = t.queue.producer.send.bind(t.queue.producer);
        vi.spyOn(t.queue.producer, "send").mockImplementation(
          async (topic, messages, opts) => {
            if (topic === "record")
              for (const message of structuredClone(messages))
                records.push({
                  id: `r${records.length}`,
                  topic: "record",
                  attempt: 1,
                  message,
                });
            return send(topic, messages, opts);
          },
        );
        return records;
      };

      it("a transient failure followed by a success records once", async () => {
        const t = await setup({ recordMode });
        await t.upload(bundle());
        const records = spyRecords(t);
        let calls = 0;
        const flaky = t.consumer({
          releases: {
            findBundleByDebugId: (p, d) => {
              if (calls++ === 0) throw new Error("store down");
              return t.store.releases.findBundleByDebugId(p, d);
            },
          },
        });
        const id = nextId();
        const first = await t.process(errorEvent(id), "a", flaky, 1);
        expect(first.result[0]?.action).toBe("retry");
        // Same delivery again, at an attempt that used to fall back to raw frames.
        const second = await flaky.handle([{ ...first.delivery, attempt: 3 }]);
        expect(second[0]?.action).toBe("ack");
        await drain(t, records);
        const event = await t.stored(first.projectId, id);
        const mapped = await groupEvent(
          first.projectId,
          event.payload as Record<string, unknown>,
        );
        expect(event.issueId).toBe(mapped.issueId);
        const issues = await t.store.issues.list({
          projectId: first.projectId,
          sort: "lastSeen",
          limit: 10,
        });
        expect(issues.items).toHaveLength(1);
        expect(issues.items[0]?.count).toBe(1);
      });

      it("a map uploaded between attempts cannot count the event twice", async () => {
        const t = await setup({ recordMode });
        const records = spyRecords(t);
        // Attempt 1 records the event under its raw-frame issue, then fails to delete the claim.
        const del = vi
          .spyOn(t.blobs, "delete")
          .mockRejectedValueOnce(new Error("blob down"));
        const id = nextId();
        const first = await t.process(errorEvent(id));
        expect(first.result[0]?.action).toBe("retry");
        del.mockRestore();
        await t.upload(bundle());
        const second = await t
          .consumer()
          .handle([{ ...first.delivery, attempt: 2 }]);
        expect(second[0]?.action).toBe("ack");
        // Direct mode skips the second attempt; grouped mode sends it under another issue.
        expect(records.length).toBe(recordMode === "grouped" ? 2 : 0);
        if (recordMode === "grouped")
          expect(new Set(records.map((r) => r.message.groupKey)).size).toBe(2);
        await drain(t, records);
        const issues = await t.store.issues.list({
          projectId: first.projectId,
          sort: "lastSeen",
          limit: 10,
        });
        expect(issues.items).toHaveLength(1);
        expect(issues.items[0]?.count).toBe(1);
      });
    },
  );

  it("does not load bundles for redelivered or suppressed events", async () => {
    const t = await setup();
    await t.upload(bundle());
    const lookup = vi.spyOn(t.store.releases, "findBundleByDebugId");
    const id = nextId();
    const first = await t.process(errorEvent(id));
    expect(lookup).toHaveBeenCalledTimes(1);
    // Redelivery: the event is stored, so the duplicate check skips it before symbolication.
    await t.blobs.put(
      (first.delivery.message.body as { blobKey: string }).blobKey,
      new TextEncoder().encode(envelope(errorEvent(id))),
    );
    await t.consumer().handle([first.delivery]);
    expect(lookup).toHaveBeenCalledTimes(1);
    const suppressing = t.consumer({ shouldSuppress: () => true });
    await t.process(errorEvent(nextId()), "a", suppressing);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("evicts parsed maps past the byte bound", async () => {
    const run = async (limits: Partial<SymbolicationLimits>) => {
      const t = await setup({ limits });
      await t.upload(bundle());
      const lookup = vi.spyOn(t.store.releases, "findBundleByDebugId");
      const deliveries: Delivery[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await t.process(errorEvent(nextId()), "a", {
          handle: async (batch: Delivery[]) => {
            deliveries.push(...batch);
            return [{ deliveryId: "d", action: "ack" as const }];
          },
        } as ConsumerService);
        expect(r.result).toHaveLength(1);
      }
      await t
        .consumer()
        .handle(deliveries.map((d, i) => ({ ...d, id: `d${i}` })));
      return lookup.mock.calls.length;
    };
    expect(await run({})).toBe(1);
    // A map heavier than the bound serves its event and is dropped, so the next one reloads it.
    expect(await run({ maxCachedBytes: 1 })).toBe(2);
    expect(await run({ maxCachedMaps: 0 })).toBe(2);
  });

  it("caps the context lines added to one event", async () => {
    const t = await setup({ limits: { maxContextCharsPerEvent: 150 } });
    await t.upload(bundle());
    const id = nextId();
    const { projectId } = await t.process(errorEvent(id));
    const event = await t.stored(projectId, id);
    const frames = framesOf(event.payload);
    expect(frames[0]).toHaveProperty("context_line");
    expect(frames[1]).not.toHaveProperty("context_line");
    expect(frames[1]).toMatchObject({ filename: "src/app.ts", lineno: 2 });
    expect((event.payload as { errors: unknown[] }).errors).toEqual([
      expect.objectContaining({ type: "js_symbolication_limit" }),
    ]);
  });

  it("groups by the symbolicated in-app frames", async () => {
    const t = await setup();
    await t.upload(bundle());
    const id = nextId();
    const { projectId } = await t.process(errorEvent(id));
    const event = await t.stored(projectId, id);
    const raw = errorEvent(id);
    const mapped = await groupEvent(
      projectId,
      event.payload as Record<string, unknown>,
    );
    expect(event.issueId).toBe(mapped.issueId);
    expect((await groupEvent(projectId, raw)).issueId).not.toBe(event.issueId);
    // The same stack from a rebuilt minified file lands in the same issue: file names, not
    // build-specific paths, feed the fingerprint.
    const again = nextId();
    const rebuilt = errorEvent(again, [
      frame(AT_CALL, { function: "c" }),
      frame(AT_NAME),
    ]);
    const second = await t.process(rebuilt);
    expect((await t.stored(second.projectId, again)).issueId).toBe(
      event.issueId,
    );
  });

  it("stores the symbolicated payload when it overflows to the blob store", async () => {
    const t = await setup();
    await t.upload(bundle());
    const id = nextId();
    const { projectId } = await t.process(
      errorEvent(id),
      "a",
      t.consumer({ overflowBytes: 10 }),
    );
    const event = await t.stored(projectId, id);
    expect(event.payloadBlobKey).toBeTruthy();
    const blob = await t.blobs.get(event.payloadBlobKey as string);
    const text = await new Response(blob).text();
    expect(text).toContain("src/app.ts");
  });

  it("symbolicates in grouped mode through a release-only reader", async () => {
    const t = await setup({ recordMode: "grouped" });
    await t.upload(bundle());
    const grouped = t.consumer({
      store: undefined,
      releases: {
        findBundleByDebugId: (p, d) =>
          t.store.releases.findBundleByDebugId(p, d),
      },
    });
    const id = nextId();
    const { result } = await t.process(errorEvent(id), "a", grouped);
    expect(result[0]?.action).toBe("ack");
  });
});
