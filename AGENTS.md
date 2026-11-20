# errtraq — agent instructions

errtraq is a Sentry-compatible, serverless-first issue tracker written in TypeScript.
**Read `docs/architecture.md` before any task**; it is the source of truth for layering,
port interfaces, the archival/erasure design, the stack-config/infra abstraction and milestones.
If a task brief conflicts with it, stop and say so instead of guessing.

## Hard rules

- **Layering**: `packages/core` depends only on its own ports and Web-standard APIs
  (fetch, WebCrypto, streams, URL, TextEncoder). No `node:*` imports, no Node globals
  (`Buffer`, `process`), no cloud SDKs in `core` or `http`. They must bundle for Cloudflare Workers.
- Adapters (`packages/adapters/*`) depend on `core`, never on each other. Platforms
  (`packages/platforms/*`) compose adapters; nothing imports from a platform.
- Every adapter package exports exactly the triple `manifest`, `create(config, bindings)`, `infra`
  (see "Stack configuration + infra abstraction"). No Terraform logic in TypeScript beyond the
  declarative `infra` descriptor; real resources live in `infra/modules/<provider>/<component>` as HCL.
- An adapter is not done until the matching contract suite from `packages/testing` runs
  against it and passes. New port behaviour ⇒ extend the contract suite first.
- Port semantics are part of the contract: queue handlers are at-least-once and idempotent on
  `eventId`; `EventRepo.put` is idempotent on `(projectId, eventId)`; `IssueRepo.recordOccurrence`
  is a single atomic operation; `MetaRepo` transitions are compare-and-set on `version`.
- No silent degradation: if a store cannot serve a query, reject via `capabilities`, don't table-scan.

## Conventions

- pnpm workspace, TypeScript strict, ESM only, Node ≥ 22 for tooling. Package names `@errtraq/<name>`.
- Tests: vitest, colocated as `*.test.ts`. Validation: zod. HTTP: Hono. SQL: Kysely.
- Keep dependencies minimal and Workers-compatible in `core`/`http`; justify each new dependency in the commit body.
- Root scripts that must always pass before you finish a task: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- Local S3 emulation uses **winterbaume** (path-style addressing only), not MinIO.

## Working agreement

- Do exactly the task slice in the brief (e.g. "M0b"); don't start the next slice or add
  unrequested adapters/features. Leave a `TODO(<milestone>)` where a later slice plugs in.
- One commit per task slice, message `M0b: <summary>`, made only after typecheck, lint and tests pass.
- Stay inside this repository. Don't install global tools, touch cloud accounts, or run `terraform apply`.
- Finish with a short report: what was built, what was verified (commands + results), and
  anything you deviated from or found wrong/underspecified in `docs/architecture.md`.
