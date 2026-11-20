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
  uploaded sourcemaps, computes a grouping fingerprint, and atomically creates or bumps an issue.
- **Serve**: a Sentry-compatible API subset for releases / artifact upload and issue / event access.
- **Archive**: events older than a per-project retention move from the active store into an
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

Implementation is at the start of milestone M0 (workspace scaffold, ports, contract tests).
See the "Milestones" section of ARCHITECTURE.md; the first round covers M0 to M2 (abstractions,
local standalone stack, infra generation). AWS is the first cloud target, Cloudflare the second.
