# Project To-Dos

Items extracted from JOURNAL.md during `good-sleep` consolidation, plus open follow-ups. Each
item should be resolved or removed once addressed. Milestone work itself is tracked in the
"Milestones" section of ARCHITECTURE.md, not here.

## Open Items

- [ ] M4 spike: confirm DuckDB iceberg-extension appends through a REST catalog against Lakekeeper and S3 Tables, and what Cloudflare Workers can do against R2 Data Catalog. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M4 spike: determine which engines can write and honor Iceberg v3 deletion vectors through a REST catalog; decide whether the native committer is needed. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M3: check whether winterbaume's DynamoDB and SQS coverage is good enough to replace DynamoDB Local and ElasticMQ in the compose file. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M1: define indexed tag-key discovery and issue tag-filter semantics before exposing tag filters through active-store adapters. — *source: JOURNAL 2026-11-21 — M0c: contract harness and memory semantics*
- [ ] M1: design crash-safe coordination of event insertion and issue occurrence updates; an inserted flag alone cannot make both operations atomic. — *source: JOURNAL 2026-11-21 — M0c review: delivery, scan and pagination contracts*
