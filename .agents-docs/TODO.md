# Project To-Dos

Items extracted from JOURNAL.md during `good-sleep` consolidation, plus open follow-ups. Each
item should be resolved or removed once addressed. Milestone work itself is tracked in the
"Milestones" section of ARCHITECTURE.md, not here.

## Open Items

- [ ] M4 spike: confirm DuckDB iceberg-extension appends through a REST catalog against Lakekeeper and S3 Tables, and what Cloudflare Workers can do against R2 Data Catalog. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M4 spike: determine which engines can write and honor Iceberg v3 deletion vectors through a REST catalog; decide whether the native committer is needed. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M3: check whether winterbaume's DynamoDB and SQS coverage is good enough to replace DynamoDB Local and ElasticMQ in the compose file. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M1: define indexed tag-key discovery and issue tag-filter semantics before exposing tag filters through active-store adapters. — *source: JOURNAL 2026-11-21 — M0c: contract harness and memory semantics*
- [x] M1: design crash-safe coordination of event insertion and issue occurrence updates; an inserted flag alone cannot make both operations atomic. — *source: JOURNAL 2026-11-21 — M0c review: delivery, scan and pagination contracts*
- [ ] M1: allocate project IDs as decimal-digit strings for Sentry-compatible DSNs. — *source: M0d final review A6*
- [ ] M2a: redesign infra references and runtime factory wiring so cross-adapter dependencies can be expressed. — *source: M0d final review B*
- [ ] M2a: expose nested sub-adapter selections so generated entrypoints import only selected engines and catalogs. — *source: M0d final review B*
- [ ] M2a: model grants with resource and policy outputs. — *source: M0d final review B*
- [ ] M2a: map topics to queues, bindings and triggers. — *source: M0d final review B*
- [ ] M2a: name cron jobs on triggers and define ownership of core schedules. — *source: M0d final review B*
- [ ] M2a: model binding type and per-function scope, including secrets and platform bindings. — *source: M0d final review B*
- [ ] M2a: define when environment references resolve (generation, Terraform or runtime). — *source: M0d final review B*
- [ ] M2a: include provider, region and module version configuration. — *source: M0d final review B*
- [ ] M2a: derive deployed function roles from platform configuration rather than a static manifest list. — *source: M0d final review B*
- [ ] M4: prevent stale lease holders overwriting staging batches, using a nonce in staged keys or conditional blob writes. — *source: M0d final review B*
