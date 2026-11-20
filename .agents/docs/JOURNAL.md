# errtraq Development Journal

Append-only log of findings, insights, decisions, and peer code review history. Add new
entries at the end as `## YYYY-MM-DD — <title>`. Do not edit existing entries. The
`good-sleep` skill consolidates entries into `.agents/docs/LTM/`.

---

## 2026-11-21 — Project bootstrap decisions

- Language is TypeScript because it is the only candidate (vs. Go, Rust) that runs natively on
  every target platform, Cloudflare Workers and Vercel included.
- The Iceberg catalog is always reached through the Iceberg REST catalog protocol so that
  Lakekeeper works, along with S3 Tables, Glue REST, and R2 Data Catalog.
- Cloud order: AWS first, then Cloudflare. Local standalone comes before both.
- The IaC layer generates a Terraform root (module composition + tfvars) from the stack config;
  the modules themselves are hand-written HCL.
- Sentry scope for the first milestones: error events, releases, and sourcemaps.
- Local S3 emulation uses winterbaume instead of MinIO. It supports path-style addressing only,
  so every S3 client in the stack (blob adapter, Lakekeeper warehouse, DuckDB, the Terraform AWS
  provider) must force path style.
- End-user PII erasure must use Iceberg v3 deletion vectors. Deletion vectors only mask rows, so
  the design pairs them with a later physical rewrite and snapshot expiry.
- Least-certain area: which engines can write and honor v3 deletion vectors through a REST
  catalog (DuckDB iceberg extension, Athena / S3 Tables, R2 Data Catalog). To be settled by the
  M4 spike; a native committer is the fallback.
- Working model: Claude Code orchestrates and reviews; a Codex session implements one milestone
  slice at a time, with one commit per slice requested in each brief.
- The agent harness (AGENTS.md layout, `.agents/docs`, `.agents/skills`, `.agents-workspace`)
  was adopted from the sibling `cornus` repository and adapted from Go to the pnpm / TypeScript gate.
