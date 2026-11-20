---
name: distill-memories
description: Read `docs/JOURNAL.md` and `docs/LTM/` documents, find durable knowledge that belongs in the canonical docs, and update those documents with concise synthesized findings. Targets are `docs/OVERVIEW.md` and the root `ARCHITECTURE.md` (plus `README.md` / a user docs site once one exists). Use when journal or LTM notes have accumulated implementation, system, or user-facing knowledge that should be promoted into the project's canonical overview, architecture, or user reference docs.
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Distill Memories

## Overview

Promote durable facts from `docs/JOURNAL.md` and `docs/LTM/` into the project's canonical documentation, keeping these up to date:

a. `docs/OVERVIEW.md` ... focused on high-level system understanding (for coding agents).
b. `ARCHITECTURE.md` (repository root) ... focused on structure, subsystems, and technical design. It is human-reader-ready and canonical; `docs/ARCHITECTURE.md` is only a pointer to it.
c. User-facing docs ... `README.md` today; a user docs site once it exists. Update them when a durable change affects what a *user* does: a new or changed CLI flag, env var, stack-config field, adapter, platform, or observable behavior.

## Sources: JOURNAL and LTM

- `docs/JOURNAL.md` is the append-only log of findings, insights, and code-review history. It holds the **freshest** durable facts, including changes not yet consolidated into LTM. The `good-sleep` / `reconcile-journal-ltm` skills consolidate JOURNAL entries into `docs/LTM/`; distill runs against whatever is present.
- `docs/LTM/` holds the consolidated, topic-organized reference material (`INDEX.md` is its table of contents).

Read both. When JOURNAL and LTM overlap, treat LTM as the settled synthesis and JOURNAL as the source of anything newer than the last consolidation. If JOURNAL records a substantial code change that the target docs (including the user docs site) do not yet reflect, that is exactly the gap this skill closes.

## Read in This Order

1. Read `docs/OVERVIEW.md` and the root `ARCHITECTURE.md` first.
2. Read `docs/JOURNAL.md` (at least the entries since the last consolidation record) and `docs/LTM/INDEX.md`.
3. Open only the LTM documents that look relevant to the gaps, stale sections, or missing detail you identified in the target docs.
4. For any candidate fact that is user-facing, open the user-docs-site page it would land on (see the map below) to check what is already documented.

Do not bulk-load every LTM file or every user-docs-site page unless the set is still small enough that selective reading costs more than reading them all.

### User-facing docs

errtraq has no docs site yet. Until one exists, user-facing facts land in `README.md`. When a user docs site is added (in its own directory, not the user docs site, which holds the agent docs), add its page map here.

The source of truth for user-facing detail is always the code (`packages/cli/src`, `packages/core/src` stack-config schema and ports, each adapter's `manifest`, `infra/modules/**/variables.tf`, etc.). Verify a fact against the code before writing it into the user docs site; JOURNAL/LTM point you at what changed, not the exact current flag or field name.

## Classify Findings Before Editing

For each candidate fact, decide whether it belongs in:

- `docs/OVERVIEW.md`: product scope, major subsystems, deployment model, high-level orientation material.
- `ARCHITECTURE.md` (repository root): module layout, subsystem boundaries, runtime architecture, data flow, interface contracts, implementation patterns, storage abstractions, and testing or operational constraints that matter to engineers. Keep it human-reader-ready — favor narrative and durable design rationale over fine-grained implementation trivia.
- the user docs site (user reference): user-observable behavior — CLI flags and commands, env vars, config/spec/chart fields, backends and providers, defaults, and the workflows that exercise them. Frame it for a user doing a task, not for a maintainer reading the code. Internal design rationale stays in `ARCHITECTURE.md`, not here.
- More than one: a single change often lands in two places (e.g. a new backend belongs in both `ARCHITECTURE.md` design and a `docs/reference` page). Update each in its own register.
- None of them: narrow bug history, one-off migrations, temporary workarounds, or details too fine-grained for canonical docs.

Prefer durable knowledge over incident history. Convert timelines into timeless guidance.

## Update Strategy

When updating the target docs:

- Synthesize; do not copy JOURNAL/LTM prose verbatim.
- Merge into existing sections when possible instead of appending random new sections.
- Add a new section only when the information represents a stable topic that the current document truly lacks. In the user docs site, a genuinely new topic may warrant a new page — if so, also add it to the sidebar and nav in `docs/.vitepress/config.mts`.
- Keep summaries compact. Core docs should stay easier to scan than the underlying notes.
- Preserve exact file paths, component names, flag/env/field names, and architecture terms when they help precision.
- For the user docs site, use only site-absolute, extensionless internal links (e.g. `/reference/deploy-spec`); link the root `README.md` / `ARCHITECTURE.md` via GitHub blob URLs, not relative `../` paths.
- If multiple sources disagree, or JOURNAL and the current code disagree, call out the ambiguity or stop and ask the user before cementing one interpretation.

## Editing Heuristics

- Favor architectural patterns over patch-level history (for OVERVIEW / ARCHITECTURE).
- Favor current subsystem boundaries over implementation anecdotes.
- For the user docs site, favor "how a user does X and what the flags/fields are" over how it is implemented.
- Omit test names unless they explain an architectural guarantee or an important invariant.
- Omit details that are already covered well in the target document.
- Fix obvious typos or stale wording in the touched sections if doing so improves clarity.

## Validation

Before finishing:

1. Re-read the edited sections of every document you changed.
2. Check that each added fact is supported by a source note (JOURNAL/LTM) and, for user-facing detail, verified against the code.
3. Check that overview-level material did not leak into architecture detail sections, that architecture rationale did not leak into the user reference, and vice versa.
4. Keep the documentation style rules in `AGENTS.md`: half-width parentheses and half-width colons (this applies to the user docs site too).
5. If you changed anything in the user docs site, build the site so the dead-link check passes:
   ```
   <the site build command recorded in docs/QUALITY_GATE.md>
   ```
   A clean build validates every internal link and anchor. If the build cannot run locally, say so rather than claiming it passed.
