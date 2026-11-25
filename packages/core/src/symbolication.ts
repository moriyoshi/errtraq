import {
  originalPositionFor,
  sourceContentFor,
  TraceMap,
} from "@jridgewell/trace-mapping";
import {
  BundleRejectedError,
  openBundleZip,
  readBounded,
} from "./artifact-bundles.js";
import type { ProjectId } from "./domain.js";
import { BlobCorruptError } from "./errors.js";
import type { BlobStore, Logger, ReleaseRepo } from "./ports.js";

type Obj = Record<string, unknown>;

/** Work bounds for one event and for the parsed-map cache of one invocation. */
export interface SymbolicationLimits {
  /** Largest stored bundle that is loaded into memory. */
  maxBundleBytes: number;
  /** Largest inflated source map. */
  maxMapBytes: number;
  /** Largest inflated `manifest.json`. */
  maxManifestBytes: number;
  /** Distinct debug IDs (bundles) resolved for one event. */
  maxBundlesPerEvent: number;
  /** Frames looked up for one event. */
  maxFramesPerEvent: number;
  /** Source maps kept parsed for one invocation; the oldest entry is evicted first. */
  maxCachedMaps: number;
  /**
   * Weight of the maps kept for one invocation: the inflated map plus its `sourcesContent` as
   * UTF-16 (the parsed copy), summed; the oldest entries are evicted past it. A map heavier than
   * this is used for the event at hand and then dropped.
   */
  maxCachedBytes: number;
  /** Characters of context lines added to one event; later frames then get no context. */
  maxContextCharsPerEvent: number;
  /** Context lines kept before and after the frame line. */
  contextLines: number;
  /** Longest context line kept, in UTF-16 units. */
  maxContextLineLength: number;
}

export const DEFAULT_SYMBOLICATION_LIMITS: SymbolicationLimits = {
  maxBundleBytes: 32 * 1024 * 1024,
  maxMapBytes: 16 * 1024 * 1024,
  maxManifestBytes: 8 * 1024 * 1024,
  maxBundlesPerEvent: 8,
  maxFramesPerEvent: 250,
  // Sized for 512 MB functions: a 32 MiB bundle is held while its 16 MiB map is parsed.
  maxCachedMaps: 8,
  maxCachedBytes: 64 * 1024 * 1024,
  maxContextCharsPerEvent: 128 * 1024,
  contextLines: 5,
  maxContextLineLength: 400,
};

type Loaded =
  | {
      kind: "ok";
      map: TraceMap;
      lines: Map<string, string[] | null>;
      weight: number;
    }
  | { kind: "missing"; reason: string }
  | { kind: "invalid"; reason: string };

const DEBUG_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ERRORS = 10;

const object = (value: unknown): Obj | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : null;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length ? value : undefined;
const entries = (value: unknown): Array<[string, Obj]> =>
  Object.entries(object(value) ?? {}).flatMap(([key, item]) => {
    const record = object(item);
    return record ? [[key, record] as [string, Obj]] : [];
  });
/** Compare script URLs without their query string or fragment. */
const normalizeUrl = (url: string) => url.replace(/[?#].*$/, "");
const baseName = (path: string) => normalizeUrl(path).split("/").at(-1) ?? "";
function header(record: Obj, name: string): string | undefined {
  for (const [key, value] of Object.entries(object(record.headers) ?? {}))
    if (key.toLowerCase() === name && typeof value === "string") return value;
  return undefined;
}
/** Display name of a bundler source: `webpack://app/./src/x.ts` becomes `src/x.ts`. */
function displayName(source: string): string {
  return source.replace(/^webpack:\/\/[^/]*\//, "").replace(/^(?:\.\/)+/, "");
}

/**
 * Rewrites minified JavaScript frames from the debug-ID source maps of uploaded artifact
 * bundles (M5b). It holds no state across invocations; {@link Symbolicator.session} creates the
 * per-invocation cache of parsed maps.
 */
export class Symbolicator {
  readonly limits: SymbolicationLimits;
  constructor(
    private readonly deps: {
      releases: Pick<ReleaseRepo, "findBundleByDebugId">;
      blobs: Pick<BlobStore, "get" | "head">;
      logger?: Pick<Logger, "warn">;
      limits?: Partial<SymbolicationLimits>;
    },
  ) {
    this.limits = { ...DEFAULT_SYMBOLICATION_LIMITS, ...deps.limits };
  }
  session(): SymbolicationSession {
    return new SymbolicationSession(this.deps, this.limits);
  }
}

export interface SymbolicationReport {
  /** Frames rewritten from a source map. */
  mapped: number;
  /** Entries appended to the event's `errors`. */
  errors: number;
}

export class SymbolicationSession {
  private readonly cache = new Map<string, Promise<Loaded>>();
  private readonly weights = new Map<string, number>();
  constructor(
    private readonly deps: ConstructorParameters<typeof Symbolicator>[0],
    private readonly limits: SymbolicationLimits,
  ) {}

  private load(projectId: ProjectId, debugId: string): Promise<Loaded> {
    const key = `${projectId}\u0000${debugId}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.fetch(projectId, debugId);
      this.cache.set(key, pending);
      // A transient failure must not poison later events of the invocation.
      pending.then(
        (loaded) => {
          if (!this.cache.has(key)) return;
          this.weights.set(key, loaded.kind === "ok" ? loaded.weight : 0);
          this.evict();
        },
        () => {
          this.cache.delete(key);
        },
      );
      this.evict();
    }
    return pending;
  }

  private evict() {
    let bytes = 0;
    for (const weight of this.weights.values()) bytes += weight;
    for (const key of [...this.cache.keys()]) {
      if (
        this.cache.size <= this.limits.maxCachedMaps &&
        bytes <= this.limits.maxCachedBytes
      )
        break;
      this.cache.delete(key);
      bytes -= this.weights.get(key) ?? 0;
      this.weights.delete(key);
    }
  }

  private async fetch(projectId: ProjectId, debugId: string): Promise<Loaded> {
    const { limits } = this;
    const bundle = await this.deps.releases.findBundleByDebugId(
      projectId,
      debugId,
    );
    // The store scopes the lookup to the project; check again so a misbehaving adapter can
    // never hand one project another project's sources.
    if (!bundle || bundle.projectId !== projectId || bundle.state !== "active")
      return { kind: "missing", reason: "no bundle owns this debug ID" };
    try {
      const head = await this.deps.blobs.head(bundle.blobKey);
      if (!head) return { kind: "missing", reason: "bundle blob is missing" };
      if (head.size > limits.maxBundleBytes)
        return { kind: "invalid", reason: "bundle is too large" };
      const body = await this.deps.blobs.get(bundle.blobKey);
      if (!body) return { kind: "missing", reason: "bundle blob is missing" };
      const bytes = await readBounded(body, limits.maxBundleBytes);
      return this.parse(bytes, debugId);
    } catch (error) {
      if (
        error instanceof BlobCorruptError ||
        error instanceof BundleRejectedError ||
        error instanceof RangeError
      )
        return { kind: "invalid", reason: "bundle is unreadable" };
      throw error;
    }
  }

  private parse(bytes: Uint8Array, debugId: string): Loaded {
    const { limits } = this;
    const capped =
      (name: string) => (file: { name: string; originalSize: number }) => {
        if (file.name !== name) return false;
        if (
          file.originalSize >
          (name === "manifest.json"
            ? limits.maxManifestBytes
            : limits.maxMapBytes)
        )
          throw new BundleRejectedError("Bundle member is too large");
        return true;
      };
    const decode = (data: Uint8Array) =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    let manifest: unknown;
    try {
      const raw = openBundleZip(bytes, capped("manifest.json")).files[
        "manifest.json"
      ];
      if (!raw) return { kind: "invalid", reason: "bundle has no manifest" };
      manifest = decode(raw);
    } catch (error) {
      if (error instanceof BundleRejectedError)
        return { kind: "invalid", reason: "manifest is too large" };
      return { kind: "invalid", reason: "manifest is unreadable" };
    }
    const files = entries(object(manifest)?.files);
    const owns = (record: Obj) =>
      header(record, "debug-id")?.toLowerCase() === debugId;
    let path = files.find(
      ([, record]) => record.type === "source_map" && owns(record),
    )?.[0];
    if (!path) {
      // Fall back to the `sourcemap` header of the minified file that carries the debug ID.
      const reference = files
        .filter(
          ([, record]) => record.type === "minified_source" && owns(record),
        )
        .map(([, record]) => header(record, "sourcemap"))
        .find(Boolean);
      if (reference) {
        const wanted = baseName(reference);
        path = files.find(
          ([name, record]) =>
            record.type === "source_map" &&
            (baseName(text(record.url) ?? name) === wanted ||
              baseName(name) === wanted),
        )?.[0];
      }
    }
    if (!path)
      return { kind: "missing", reason: "bundle has no source map for it" };
    let map: TraceMap;
    let weight = 0;
    try {
      // The manifest stays selected: it is how openBundleZip recognizes the right ZIP offset.
      const raw = openBundleZip(
        bytes,
        (file) => capped("manifest.json")(file) || capped(path)(file),
      ).files[path];
      if (!raw)
        return { kind: "missing", reason: "source map is not in the bundle" };
      const parsed = object(decode(raw));
      if (!parsed || typeof parsed.mappings !== "string")
        return { kind: "invalid", reason: "source map has no mappings" };
      map = new TraceMap(parsed as never);
      weight = mapWeight(raw.byteLength, parsed);
    } catch (error) {
      if (error instanceof BundleRejectedError)
        return { kind: "invalid", reason: "source map is too large" };
      return { kind: "invalid", reason: "source map is unreadable" };
    }
    return { kind: "ok", map, lines: new Map(), weight };
  }

  /**
   * Rewrite the minified frames of `event` in place and append problems to `event.errors`.
   * Infrastructure failures (store or blob I/O) always propagate so the delivery is retried:
   * falling back to raw frames would give one event two different issue IDs across attempts.
   */
  async symbolicate(
    projectId: ProjectId,
    event: Obj,
  ): Promise<SymbolicationReport> {
    const report: SymbolicationReport = { mapped: 0, errors: 0 };
    const images = new Map<string, string>();
    const rawImages = object(event.debug_meta)?.images;
    for (const raw of Array.isArray(rawImages) ? rawImages.slice(0, 64) : []) {
      const image = object(raw);
      const debugId = text(image?.debug_id)?.toLowerCase();
      const file = text(image?.code_file);
      if (
        image?.type === "sourcemap" &&
        file &&
        debugId &&
        DEBUG_ID.test(debugId) &&
        !images.has(normalizeUrl(file))
      )
        images.set(normalizeUrl(file), debugId);
    }
    if (!images.size) return report;
    const stacks = stackFrames(event);
    if (!stacks.some((frames) => frames.length)) return report;

    const errors: Obj[] = [];
    const note = (entry: Obj) => {
      if (errors.length < MAX_ERRORS) errors.push(entry);
    };
    const resolved = new Map<string, Loaded>();
    const budget = { chars: this.limits.maxContextCharsPerEvent, hit: false };
    let looked = 0;
    let limited = false;
    for (const frames of stacks) {
      let callerName: string | undefined;
      for (let i = 0; i < frames.length; i++) {
        const frame = object(frames[i]);
        const previousName = callerName;
        callerName = undefined;
        if (!frame) continue;
        const url = text(frame.abs_path) ?? text(frame.filename);
        const debugId = url ? images.get(normalizeUrl(url)) : undefined;
        const lineno = frame.lineno;
        const colno = frame.colno;
        if (
          !url ||
          !debugId ||
          typeof lineno !== "number" ||
          !Number.isInteger(lineno) ||
          lineno < 1 ||
          typeof colno !== "number" ||
          !Number.isInteger(colno) ||
          colno < 0
        )
          continue;
        if (looked >= this.limits.maxFramesPerEvent) {
          limited = true;
          break;
        }
        let loaded = resolved.get(debugId);
        if (loaded === undefined) {
          if (resolved.size >= this.limits.maxBundlesPerEvent) {
            limited = true;
            continue;
          }
          loaded = await this.load(projectId, debugId);
          resolved.set(debugId, loaded);
          if (loaded.kind !== "ok")
            note({
              type:
                loaded.kind === "missing"
                  ? "js_no_source"
                  : "js_invalid_source",
              url: normalizeUrl(url),
              debug_id: debugId,
              reason: loaded.reason,
            });
        }
        if (loaded?.kind !== "ok") continue;
        looked++;
        const rewritten = this.rewrite(
          loaded,
          frame,
          url,
          debugId,
          lineno,
          colno,
          previousName,
          budget,
        );
        if (!rewritten) continue;
        frames[i] = rewritten.frame;
        callerName = rewritten.name;
        report.mapped++;
      }
    }
    if (limited || budget.hit)
      note({
        type: "js_symbolication_limit",
        reason: "per-event symbolication limit reached",
      });
    if (errors.length) {
      const existing = Array.isArray(event.errors) ? event.errors : [];
      event.errors = [...existing, ...errors];
      report.errors = errors.length;
    }
    return report;
  }

  private rewrite(
    loaded: Extract<Loaded, { kind: "ok" }>,
    frame: Obj,
    url: string,
    debugId: string,
    lineno: number,
    colno: number,
    callerName: string | undefined,
    budget: { chars: number; hit: boolean },
  ): { frame: Obj; name?: string } | null {
    const position = originalPositionFor(loaded.map, {
      line: lineno,
      column: Math.max(0, colno - 1),
    });
    if (!position.source || position.line === null) return null;
    const { source } = position;
    const minified: Obj = {};
    for (const key of [
      "abs_path",
      "filename",
      "lineno",
      "colno",
      "function",
    ] as const)
      if (frame[key] !== undefined) minified[key] = frame[key];
    const next: Obj = { ...frame };
    // Derived from the minified file, so it would only make the grouping depend on the build.
    delete next.module;
    delete next.context_line;
    delete next.pre_context;
    delete next.post_context;
    next.abs_path = source;
    next.filename = displayName(source);
    next.lineno = position.line;
    next.colno = (position.column ?? 0) + 1;
    // A token names the identifier at the call site, which is the function of the next frame.
    if (callerName) next.function = callerName;
    if (/(^|[\\/])node_modules[\\/]/.test(source)) next.in_app = false;
    const lines = this.sourceLines(loaded, source);
    const line = lines?.[position.line - 1];
    if (lines && line !== undefined) {
      const { contextLines } = this.limits;
      const pre = lines.slice(
        Math.max(0, position.line - 1 - contextLines),
        position.line - 1,
      );
      const post = lines.slice(position.line, position.line + contextLines);
      const chars = [line, ...pre, ...post].reduce((n, l) => n + l.length, 0);
      if (chars <= budget.chars) {
        budget.chars -= chars;
        next.context_line = line;
        next.pre_context = pre;
        next.post_context = post;
      } else budget.hit = true;
    }
    next.data = {
      ...(object(frame.data) ?? {}),
      symbolicated: true,
      sourcemap: debugId,
      minified: { ...minified, abs_path: url },
    };
    return { frame: next, name: position.name ?? undefined };
  }

  private sourceLines(
    loaded: Extract<Loaded, { kind: "ok" }>,
    source: string,
  ): string[] | null {
    let lines = loaded.lines.get(source);
    if (lines === undefined) {
      const content = sourceContentFor(loaded.map, source);
      const max = this.limits.maxContextLineLength;
      lines =
        typeof content === "string"
          ? content
              .split(/\r\n|\r|\n/)
              .map((line) => (line.length > max ? line.slice(0, max) : line))
          : null;
      loaded.lines.set(source, lines);
    }
    return lines;
  }
}

/** Resident size estimate: the inflated map text plus its parsed `sourcesContent` (UTF-16). */
function mapWeight(rawBytes: number, parsed: Obj): number {
  let chars = 0;
  if (Array.isArray(parsed.sourcesContent))
    for (const content of parsed.sourcesContent)
      if (typeof content === "string") chars += content.length;
  return rawBytes * 2 + chars * 2;
}

/** The frame arrays of the exception chain, the top-level stack and the threads. */
function stackFrames(event: Obj): unknown[][] {
  const stacks: unknown[][] = [];
  const add = (stacktrace: unknown) => {
    const frames = object(stacktrace)?.frames;
    if (Array.isArray(frames)) stacks.push(frames);
  };
  const values = object(event.exception)?.values;
  if (Array.isArray(values))
    for (const value of values) add(object(value)?.stacktrace);
  add(event.stacktrace);
  const threads = object(event.threads)?.values;
  if (Array.isArray(threads))
    for (const thread of threads) add(object(thread)?.stacktrace);
  return stacks;
}
