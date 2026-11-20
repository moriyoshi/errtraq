# Documents for both humans and coding agents

* [ARCHITECTURE.md](./ARCHITECTURE.md) ... system architecture (canonical; human-reader-ready): layering, port interfaces, the archival and erasure designs, the stack-config / infra abstraction, milestones, and verification. **Read it before any task.** If a task brief conflicts with it, stop and say so instead of guessing.

# Documents for coding agents

* [./.agents-docs/OVERVIEW.md](./.agents-docs/OVERVIEW.md) ... project overview.
* [./.agents-docs/JOURNAL.md](./.agents-docs/JOURNAL.md) ... findings, insights, and peer code review history.
* [./.agents-docs/LTM/INDEX.md](./.agents-docs/LTM/INDEX.md) ... long-term memory index for durable project knowledge under `./.agents-docs/LTM/`.
* [./.agents-docs/TODO.md](./.agents-docs/TODO.md) ... open to-do items extracted from JOURNAL.md during `good-sleep` consolidation, plus open follow-ups. Check and update this file when picking up or finishing work.
* [./.agents-docs/QUALITY_GATE.md](./.agents-docs/QUALITY_GATE.md) ... the standard verification gate to run before declaring a change complete.

# Skills

Shared agent skills live under `./.agents/skills/` (Codex reads them there; `./.claude/skills` is a symlink to the same directory, so Claude Code sees the identical set).

* `good-sleep` ... consolidate `JOURNAL.md` into topic-organised documents under `.agents-docs/LTM/`, and extract to-dos into `TODO.md`.
* `deep-sleep` ... merge and synthesize overlapping LTM documents.
* `reconcile-journal-ltm` ... audit `JOURNAL.md` against LTM and remove entries that are already consolidated.
* `distill-memories` ... promote durable knowledge from JOURNAL / LTM into `OVERVIEW.md` and `ARCHITECTURE.md`.
* `tackle-todos` ... sweep `TODO.md` and `TODO` / `FIXME` comments and resolve them in bulk.
* `translate-documents` ... translate or audit Markdown documentation.

# Rules and protocols

## General

* errtraq is a Sentry-compatible, serverless-first issue tracker written in TypeScript. Every backing service (active store, queue, blob store, archive, compute platform) is a pluggable adapter behind a port, and the same stack config that wires the adapters at runtime also generates the Terraform that provisions them.
* **Layering**: `packages/core` depends only on its own ports and Web-standard APIs (fetch, WebCrypto, streams, URL, TextEncoder). No `node:*` imports, no Node globals (`Buffer`, `process`), and no cloud SDKs in `core` or `http`. They must bundle for Cloudflare Workers.
* Adapters (`packages/adapters/*`) depend on `core`, never on each other. Platforms (`packages/platforms/*`) compose adapters; nothing imports from a platform.
* Every adapter package exports exactly the triple `manifest`, `create(config, bindings)`, `infra` (see "Stack configuration + infra abstraction" in ARCHITECTURE.md). No Terraform logic in TypeScript beyond the declarative `infra` descriptor; real resources live in `infra/modules/<provider>/<component>` as HCL.
* Port semantics are part of the contract: queue handlers are at-least-once and idempotent on `eventId`; `EventRepo.put` is idempotent on `(projectId, eventId)`; `IssueRepo.recordOccurrence` is a single atomic operation; `MetaRepo` transitions are compare-and-set on `version`.
* No silent degradation: if a store cannot serve a query, reject via `capabilities`; do not table-scan.
* Do exactly the task slice in the brief (e.g. "M0b"). Do not start the next slice or add unrequested adapters or features. Leave a `TODO(<milestone>)` comment where a later slice plugs in.

## File Management

* When you'd make summary documents for your work, be sure to write them under `./.agents-docs`, not under `/tmp`.
* Temporary files should be created under `./.agents-workspace/tmp`, not under `/tmp`.
* ❌ Do not write build output or generated bundles into the version-controlled tree outside the git-ignored locations (`dist/`, `infra/generated/`). One-off experiment output goes to `./.agents-workspace/tmp`.
* ❌ Never delete user files without permission. Only safe to delete: files YOU created in THIS session that are in `./.agents-workspace/tmp/`. Always ask first if unsure. Assume all pre-existing files belong to the user.
* Stay inside this repository. Do not install global tools, touch cloud accounts, or run `terraform apply`.

## Building

* pnpm workspace, TypeScript strict, ESM only, Node `^22.18.0 || >=23.6.0` for tooling. Package names are `@errtraq/<name>`.
* Validation: zod. HTTP: Hono. SQL: Kysely. Keep dependencies minimal and Workers-compatible in `core` / `http`; justify each new dependency in your report.
* The standard local gate for any change you make (this applies to subagents too):
  ```
  pnpm typecheck
  pnpm lint
  pnpm test                      # or focused: pnpm --filter @errtraq/<pkg> test
  ```
  Fix violations and re-run until clean. Do not declare a change complete with failing typecheck, lint, or tests. See [QUALITY_GATE.md](./.agents-docs/QUALITY_GATE.md) for the deeper levels.

## Testing

* Make sure that regression tests are ready for your fix.
* Tests: vitest, colocated as `*.test.ts`.
* An adapter is not done until the matching contract suite from `packages/testing` runs against it and passes. New port behaviour means extending the contract suite first.
* The default `pnpm test` path must run without external daemons, network access, or cloud credentials. Tests that need an emulator (winterbaume, Lakekeeper, a database server) are opt-in and must skip when the service is absent.
* Local S3 emulation uses **winterbaume** (path-style addressing only), not MinIO.

## Git Workflow

* ❌ Do not run `git checkout` or `git restore` against the working tree. Another agent may be working concurrently in the same directory.
* ✅ For now (bootstrap phase), every agent (Claude Code and Codex alike) may commit freely, without being asked. Commit whenever a coherent unit of work passes the gate; small, frequent commits are preferred over one large one.
  * Message format: `<slice>: <summary>` for milestone work (e.g. `M0c: contract suites and in-memory fakes`), or a plain imperative summary for anything else. Say in the body who implemented and who reviewed when both agents were involved.
  * Stage only the files you changed (`git add <paths>`). Do not use `git add -A` or `git commit -a`: another agent may have unfinished work in the same tree.
  * ❌ Do not rewrite history that is not yours: no `git commit --amend` on another agent's commit, no rebase, no reset, no force.
  * ❌ Pushing is not covered by this rule. Push only when the user explicitly asks.
* If your sandbox cannot write to `.git`, do not work around it. Leave the changes uncommitted, say so in your report, and the other agent will commit them after review.

## Documentation

* Finish every task with a short report: what was built, what was verified (commands and results), and anything you deviated from or found wrong or underspecified in `ARCHITECTURE.md`.
* Append durable findings (non-obvious constraints, dead ends, decisions and their reasons, review outcomes) to the end of `./.agents-docs/JOURNAL.md` as a dated `## YYYY-MM-DD — <title>` entry. Do not journal routine progress.
* Try to write your work summary to one of the existing documents under `./.agents-docs`.
* ❌ Avoid editing any existing sections of `JOURNAL.md`. Append new entries to the end. (The sole exception is the `reconcile-journal-ltm` skill, which may remove entries already consolidated into `.agents-docs/LTM/` per the canonical `## LTM Consolidation Record`.)
* ❌ For repo-authored documentation only (e.g. `AGENTS.md`, `README.md`, `.agents-docs/**`), never use full-width parentheses (`（` `）`). Use half-width parentheses (`(` `)`) with a half-width space before/after when adjacent to a non-whitespace character. This does not apply to generated or third-party reference files under `skills/**/references/**`.
* ❌ For repo-authored documentation only, never use full-width colons (`：`). Use a half-width colon followed by a half-width space. This does not apply to generated or third-party reference files under `skills/**/references/**`.

## Shell Pitfalls (prezto defaults)

The user's shell uses prezto, which sets aliases and options that break non-interactive scripts:

* ❌ `cp src dst` prompts interactively when `dst` exists (prezto aliases `cp` to `cp -i`). Always `rm -f dst` before `cp`.
* ❌ `cat > file <<'EOF'` and `echo > file` fail with `file exists` when the target exists (prezto enables `NO_CLOBBER`). Workaround: `rm -f file` before writing, or use `tee` / `/bin/cat`.
* ❌ `rm file` prompts for confirmation on some files (prezto aliases `rm` to `rm -i`). Always use `rm -f` for non-interactive deletion.
