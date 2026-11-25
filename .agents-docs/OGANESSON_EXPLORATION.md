# Oganesson exploration: a single-executable errtraq

Date: 2026-11-26. Status: exploration only; no product code changed. The spike lives under
`.agents-workspace/tmp/oganesson-spike/` (git-ignored scratch) and the oganesson clone under
`.agents-workspace/tmp/oganesson/` (one local patch, see "Spike").

## Verdict in one paragraph

A single executable running the errtraq HTTP surface (ingest + API) on a pure-Go SQLite works today
with small shims: the spike ingested a Sentry envelope (plain and gzip), grouped it, and served it back
through `/api/0` from one 37 MB binary with no Node. What does not fit is the standalone platform's
process model: oganesson runs every request in a fresh JavaScript VM, so the in-memory queue consumer
loop, the cron and cleanup timers, and the in-memory KV (rate limits) cannot live in JS. The viable path
is a dedicated "oganesson" platform that is request-scoped (inline queue drain, or a Go-hosted
scheduler), plus a durable SQLite fix and a blob store that does not depend on `node:fs`. DuckDB/Iceberg
archive is blocked. Recommendation: do not retarget `platforms/standalone`; consider a new
`platforms/oganesson` only after two upstream changes (durable SQLite on host paths, a process-wide
background hook). Details below.

## 1. Oganesson

- Repo: public, MIT, by the project owner. About 58k lines of Go (excluding vendored), 104 Go test files,
  active (recent merges). Requires Go 1.27 to build from source. The released `og` 0.2.1 is older than
  the source and failed on Vite 8.3.3 (rolldown "Class extends value is not a constructor"); the spike
  therefore built `og` from source (`scripts/sync-typescript.sh` fetches TypeScript-Go, then
  `scripts/build-og.sh`; about 100 s and 70 s).
- Engine: Sobek (Grafana fork of Goja, pure Go); an experimental Ekuma backend exists. Not V8: stack
  formats and function names differ, `WeakRef` is a polyfill, ES syntax is lowered by esbuild.
- Build: esbuild (Go library) bundles; the installed `og install` is an npm-free installer (public
  registry only, no lifecycle scripts). Vite and Next.js builds run inside an embedded JS host.
- App entry: Next.js, or a Vite project. A non-framework server is supported as a "server program": the
  `start`/`preview`/`serve` script runs `node <file>`, and og bundles that file. Detection requires a
  Vite project that also runs at least one `vite build --ssr` (the spike needed a trivial dummy SSR
  entry and `vite` as a devDependency; Hono with `@hono/node-server` is a validated shape). `listen()`
  opens nothing; og owns the single `net/http` listener and hands each request to the registered
  listener.
- Runtime model: the bundle is compiled once per process; every request gets a fresh VM and event loop
  (about 14 ms setup per the docs). Module state, timers and unfinished promises do not survive a
  request. Shared state must be Go-backed (`og:kv` is memory-only, SQLite, DB pools).
- Node surface (unenv based plus real implementations): `fs` (virtual: packaged files plus an in-memory
  overlay, no host disk), `crypto`/WebCrypto (SHA, HMAC, AES, ECDSA, Ed25519, ...), `zlib` (gzip,
  deflate, brotli), `CompressionStream`/`DecompressionStream`, streams, `fetch` on Go's client, `Buffer`,
  `process`, timers, `AsyncLocalStorage`, outbound `net`/`tls`. No inbound `net.Server`, no WebSocket
  server, no child processes, no `worker_threads` at runtime.
- Native addons: not loadable (`ERR_DLOPEN_FAILED`). Substitutes: `better-sqlite3` over modernc SQLite,
  `pg` (pgx), `mysql2`, `sharp` subset, `bcrypt`. `node:sqlite` is not provided (no match in source).
- Packaging: payload zip appended to a runtime executable (trailer `OGPAYLD1`). With the Go toolchain the
  runtime is a slim serve-only binary; without Go the whole `og` (about 77 MB) is copied. Cross targets
  via `-target goos/goarch` (pure Go, CGO off). Not exercised in the spike.
- Gap between docs and code: docs say to pass an absolute host path for durable SQLite, but in the
  packaged runtime `runtime/natives/sqlite.go` routes every non-memory filename into the in-memory
  overlay when the runtime filesystem is installed (the host-path branch is only the fallback when no
  overlay exists). Measured: data vanished on restart.

## 2. Compatibility matrix (standalone path)

| Area | errtraq standalone usage | Verdict |
|------|--------------------------|---------|
| Hono apps (`http`) | `createIngestApp`, `createApiApp`, Hono routing | Works (spike) |
| HTTP server | `@hono/node-server` `serve` | Works, but og owns the listener: host/port from `-addr`/`PORT`, ignoring `cfg.host`/`cfg.port` |
| SQLite | `node:sqlite` `DatabaseSync` via Kysely | Works with shim: alias `node:sqlite` to a thin wrapper over `better-sqlite3` (og's Go-backed substitute). Durable only with an upstream fix (below) |
| Transactions, `begin immediate`, WAL pragmas | `store-sql` | Worked in the spike (migrations, `recordOccurrence`, idempotent put) |
| blob-fs | `node:fs/promises` `open`, `file.write(buf, off, len, pos)`, `O_NOFOLLOW`, rename | Blocked: runtime fs is virtual and in-memory; `FileHandle.write` does not exist (spike error `Object has no member 'write'`). Needs a different blob adapter |
| queue-memory | long-lived pull loop | Shim needed: state is per VM. Spike drains the queue inline after each request; real option is a Go-backed queue or a durable SQL queue |
| kv-memory | rate limits, cooldowns | Shim needed: per-VM state is lost each request; use `og:kv` (process-wide, memory) or SQL |
| Timers and cron | `setInterval` bundle cleanup, cron registry | Blocked in JS (VM dies with the request). Needs Go-side scheduler calling an internal route, or an external trigger |
| Graceful shutdown, queue idle | `server.close`, `queue.idle` | Not applicable; og handles SIGINT/SIGTERM |
| WebCrypto | token hashing, id generation | Works (spike) |
| gzip ingest | `DecompressionStream`/zlib | Works (spike, gzip envelope accepted) |
| Envelope parsing | `IngestService`, `ConsumerService` | Works (spike) |
| Source maps | `@jridgewell/trace-mapping` (pure JS) | Expected to work; not exercised (needs blobs, so depends on the blob answer) |
| Archive tier | `@duckdb/node-api` native binding, Lakekeeper | Blocked. Alternatives: disable archive in this target; or a Go-side bridge exposed as an `og:` native module (a Go Iceberg REST client plus Parquet writer, or DuckDB through a CGO-free route, which does not exist today); or call out to an external archive service over HTTP |
| Web UI (future) | static assets plus API | Good fit: client assets are packaged, same listener |
| Dev token file, `tokenDirectory` | `node:fs` with O_NOFOLLOW, chmod | Blocked as written; replace with SQL-stored token |
| CLI (`errtraq dev/build/migrate`) | Node tooling | Out of scope for the binary; `migrate` can run at start (idempotent) |
| Process model | one long-lived process | Mismatch: per-request VM (about 70 ms per request warm in the spike) |

## 3. Spike

Location: `.agents-workspace/tmp/oganesson-spike/`. Nothing under `packages/` was touched.

Construction:
1. `build-bundle.mjs` uses the repo's esbuild (0.28.2) to bundle `src/entry.ts` into one ESM file
   (1.4 MB). The entry composes real errtraq code: `@moriyoshi/errtraq-http` apps, core
   `IngestService`/`ConsumerService`/`bootstrapProject`, `store-sql` on sqlite, `queue-memory`, and
   `kv-memory`. `node:sqlite` is aliased to `src/node-sqlite-shim.ts` (`DatabaseSync` over
   `better-sqlite3`); `better-sqlite3` stays external so og substitutes its Go version.
2. `app/` is an og project: `package.json` (hono, `@hono/node-server`, `better-sqlite3`, vite as
   devDependency, `start` = `node server.mjs`), a stub `index.html`, `vite.config.js`, a one-line
   `src/entry-server.js` (only to trigger server-program detection), and `server.mjs` calling `serve`.
3. Because the stack objects live per VM, `createApp` rebuilds store, queue, blob and kv on every
   request, runs `migrate` and idempotent bootstrap, serves the request, then drains the in-memory queue
   inline (aborting the pull loop when `idle()` is true). Blob store is the testing package's
   `MemoryBlobStore` (blob-fs cannot work, see matrix).

Commands (run from the spike directory):
- `og install -v app` (installs hono, @hono/node-server, better-sqlite3 and vite)
- `og-src build -go /nonexistent/go -o errtraq-og-full app` for the full-runtime binary, or
  `og build -og-source <oganesson clone> -o errtraq-og-slim app` for the slim one
- `run-spike.sh <binary>` starts the binary on an explicit address, posts an envelope with curl, and
  reads `/api/0/projects/default/default/issues` back with a bearer token.

Results:

| Item | Result |
|------|--------|
| Plain envelope ingest | 200, event grouped, issue visible via API (title, culprit, count 1) |
| gzip envelope | 200, accepted (count 2 after a distinct event id) |
| Duplicate event id | Not double counted (idempotent put works) |
| Binary size | slim (Go toolchain, local `-og-source`): 36.9 MB; full runtime copy: 77.3 MB |
| Time to first 200 after launch | about 1.3 s slim, about 1.5 to 2.0 s full (includes first bundle compile, the docs say about 670 ms, and migrate on a fresh database) |
| Warm request latency | about 70 to 100 ms per request through curl (health 70 ms; ingest about 80 to 150 ms); 5 to 22 ms of that is in-handler per the `x-spike-ms` header, the rest is VM creation and bundle evaluation |
| Resident memory | about 135 to 147 MB after a few requests |
| Durable SQLite | Failed with unmodified oganesson (database in memory overlay, empty after restart). Passed after a one-line local patch in the clone (`runtime/natives/sqlite.go`: use the host file branch when the filename is absolute). Events survive restart (WAL files appear in the data directory) |

What broke and the shims:
1. Released `og` 0.2.1 failed to build Vite 8.3.3 projects; built og from source.
2. Server-program detection needs a Vite SSR build; dummy entry added.
3. `node:sqlite` missing: alias shim over `better-sqlite3`.
4. blob-fs: `FileHandle.write` missing and fs is not host disk; replaced with in-memory blob (spike only).
5. SQLite not durable (above), one-line local patch.
6. Process-level concerns not reproducible: queue drain done inline; cron, cleanup, rate-limit KV not
   exercised. Timers and cross-request state were not tested empirically (documented behaviour only).
7. The released slim-runtime build via the module proxy failed for an unpublished TypeScript-Go module
   revision, so the slim binary needs a local `-og-source` checkout.

Not tested: cross-compilation, source-map symbolication, the `sentry-cli` upload path (needs
durable blobs), real `@sentry/node` SDK traffic, concurrency under load, archive. Docker was not
needed (the orchestrator reported the Docker socket unavailable; no step used it).

## 4. Options and recommendation

Option A, "errtraq build --target oganesson" producing an og project plus binary (recommended shape if
pursued). Pieces and rough effort:
- `platforms/oganesson` (request-scoped platform: build stores once per VM, inline queue drain or
  claim-check processed by a Go-side worker, no timers): 1 to 2 weeks including contract tests.
- A `node:sqlite`-compatible shim package or a `store-sql` dialect option for `better-sqlite3`: 2 to 3 days
  (the spike shim is about 25 lines; the real work is semantics such as busy handling and `iterate`).
- Blob adapter that works on og: `blob-sql` (blobs as rows in the same SQLite, streaming limits apply)
  or an og native Go module exposing host-file blobs: 1 week with the contract suite.
- Durable queue so that work survives VM death and restarts: `queue-sql` (table with leases) 1 week; it
  also serves other single-node setups.
- Scheduler: a Go `wrap.go` ticker hitting an internal cron route, or an og native module: 3 to 5 days.
  Needs the ejected-Go-module build mode (documented, needs the og source).
- Rate limit / KV: SQL-backed or `og:kv` adapter: 2 to 3 days.
- CLI target (`errtraq build --target oganesson`, generating the project, running og): about 1 week.
- Archive: excluded in v1. A Go-side Iceberg bridge is a separate 3 to 6 week project.
Total for a supported, SQLite-only single binary: about 5 to 7 weeks.

Option B, keep Node and ship the existing Node bundle via `node --experimental-sea` or Bun/`pkg`-style
packaging. Lower risk, keeps DuckDB (as a sidecar native file), larger binary, still needs a Node runtime
embedded. Cheaper (days) if "one file" matters more than "pure Go".

Option C, do nothing now; keep the container image as the single deployable (already done in M4i).

Risks: per-request VM cost (70+ ms warm, bad for high-volume ingest); no background work model; Sobek is
not V8 (stack formats matter for symbolication tests); oganesson maturity (version drift between docs,
released binary and source, one durability bug found within an hour); only Next/Vite entry points are
first class, so errtraq would rely on the "server program" path via a dummy Vite build; small
maintainer surface. Throughput is explicitly not a goal of oganesson.

Recommendation: errtraq's value on the standalone target is a long-lived process with background
workers; oganesson trades that away. Treat it as an experimental, SQLite-only, low-volume "try it" target
(single-user, demo, edge-of-network box) and do not fold it into the standalone platform. Start only if
upstream lands the two blocking changes below; otherwise stay with the container (Option C).

## 5. Proposed upstream oganesson changes

Filed 2026-11-26 on the oganesson repository as issues #14 (durable SQLite), #15 (host mounts and FileHandle), #21 (startup hook and scheduler), #16 (`node:sqlite`), #17 (plain server entries), #18 (persistent `og:kv`), #19 (release and Go module) and #20 (long-lived VM mode), in the order below.

1. Durable SQLite on absolute paths: in `runtime/natives/sqlite.go` take the host-file branch for absolute
   filenames even when `Files` is set (the spike's one-line patch), plus a test and the docs claim made
   true. Also support `OG_DATA_DIR`-style mounts for node:fs.
2. Host filesystem mounts: a documented opt-in host directory mapping for `node:fs` (read/write), so that
   adapters like blob-fs can run; at minimum implement `FileHandle.read/write/sync/close` over the
   overlay.
3. Process-wide lifecycle hooks: a startup hook that runs once in a long-lived (non-request) VM or Go
   callback, and a scheduler API (`og:cron`-like, interval and cron expression) invoking a JS handler in
   a fresh VM. This removes the biggest mismatch.
4. A `node:sqlite` module (`DatabaseSync`, `StatementSync`) backed by the existing Go SQLite service, so
   Node 22 code runs unmodified.
5. First-class plain server entries: allow `og build --entry server.mjs` without requiring Vite or a
   dummy SSR build.
6. Optional persistent `og:kv` backend (SQLite file) to make it usable for rate limits.
7. Release hygiene: a released `og` that builds current Vite 8, and a published Go module so the slim
   runtime builds without a local checkout.
8. Optional: keep-alive "single long-lived VM" mode (no per-request isolation) for apps that are already
   stateless-safe, which would cut the per-request cost and permit in-memory queues.

## 6. Open questions

- Is a single-executable target wanted for production use or only for demos and local trials?
- Is a per-request VM acceptable for ingest throughput targets?
- Should a durable SQL queue become a general adapter (also useful for standalone on multiple processes)?
- Will the owner take upstream changes 1 to 3 (they decide feasibility of Option A)?
- Archive: external service, disabled, or a Go bridge?
- Licensing and notices: oganesson bundles many third-party components (`og licenses`); a notices
  strategy for shipped binaries would be needed.
