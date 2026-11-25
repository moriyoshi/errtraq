# errtraq Overview

errtraq is a Sentry-compatible issue tracker in the spirit of GlitchTip and Bugsink, written
in TypeScript and designed to run entirely on serverless platforms (AWS Lambda, Cloudflare
Workers, Cloud Run, Vercel) while also running locally as one standalone Node process.
Existing Sentry SDKs and `sentry-cli` point at an errtraq DSN unchanged.

The canonical design is the root [ARCHITECTURE.md](../ARCHITECTURE.md). This file is the
short orientation; it is kept current by the `distill-memories` skill.

## What it does

- **Ingest**: accepts Sentry envelopes (and the legacy store endpoint), stages the raw payload
  in a blob store, and enqueues a small reference (claim-check).
- **Process**: a queue consumer normalizes the event, symbolicates JavaScript frames from
  uploaded sourcemaps (M5), computes a grouping fingerprint, and atomically creates or bumps an issue.
- **Serve**: a Sentry-compatible API subset for issue / event access, and (M5) releases / artifact upload.
- **Archive** (M4): events older than a per-project retention move from the active store into an
  Iceberg table (via the Iceberg REST catalog protocol, e.g. Lakekeeper) and stay queryable
  together with active events. End-user PII erasure uses Iceberg v3 deletion vectors followed by
  a physical rewrite.

Scope is error events plus releases and sourcemaps. Transactions, replays, profiles, and
sessions are accepted and dropped.

## How it is put together

Five layers, each depending only on the one below:

| Layer | Contents |
|-------|----------|
| L4 Entrypoints | Per-platform handlers (Lambda, Worker, Node server), generated per stack |
| L3 Apps | Hono apps: ingest, api, queue consumer, cron |
| L2 Core services | Ingest, normalize, grouping, symbolication, federated query, archival, erasure |
| L1 Ports | `ActiveStore`, `Queue`, `BlobStore`, `ArchiveStore`, `KV`, `Scheduler`, clock / id / logger |
| L0 Adapters | SQL family (sqlite, postgres, mysql, D1, libsql), DynamoDB, Firestore; memory / SQS / Cloudflare Queues / Redis / NATS / Pub/Sub queues; fs / S3-compatible / GCS / Azure blobs; Iceberg REST |

`core` and `http` use only Web-standard APIs so they bundle for Workers.

## One config drives runtime and infrastructure

A typed stack file (`stacks/*.ts`, `defineStack({...})`) selects a platform and one adapter per
port. Each adapter exports `manifest`, `create(config, bindings)`, and a declarative `infra`
descriptor. The `errtraq` CLI validates the combination, builds a bundle containing only the
selected adapters, and generates a Terraform root (`main.tf.json` + tfvars) that composes
hand-written HCL modules under `infra/modules/`. Terraform sets the function environment from
module outputs, so the application and its infrastructure cannot drift.

## Status

M0 (ports, stack-config validation, contract suites) and M1 (local standalone stack) are done.
`errtraq dev --stack stacks/local.ts` runs ingest, consumer, the minimal `/api/0` API and a cron
timer in one Node process on SQLite, an in-memory queue, filesystem blobs and an in-memory KV;
`pnpm e2e` drives it with the real `@sentry/node` SDK. M2 is complete: the infra model,
Terraform generator, AWS modules, role-scoped build and generation CLI, and standalone container
are in place. M3 is in progress: the AWS runtime adapters (DynamoDB store and KV, PostgreSQL with
RDS IAM authentication, SQS, S3), deployed secret sources, exact rate counting with per-project
limits and the deployed bootstrap function (`errtraq bootstrap --remote`) are implemented, and real
AWS deployments have passed; the remaining M3 verification is tracked in `TODO.md`. Packages publish
to GitHub Packages as `@moriyoshi/errtraq-*`. Releases and sourcemaps (M5) are not implemented yet:
the API serves issues and events only. See "Milestones" in ARCHITECTURE.md.
