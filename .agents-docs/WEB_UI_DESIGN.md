# Web UI design (issues and events dashboard)

Status: proposal (2026-11-26), not yet scheduled. `ARCHITECTURE.md` places the web UI under
M7+; this document fixes its shape so the backend slices it needs can be planned. Slice names
below (`UI-a` and so on) are placeholders until the owner assigns a milestone.

## Goals and constraints

- Feature parity with the issue and event views of GlitchTip and Bugsink, which are a subset of
  Sentry's. Performance, replays, profiles and sessions stay out, because ingest drops them.
- Serverless deployment with no cost while idle: no always-on server, no BFF.
- The browser calls the existing Sentry-compatible `/api/0` directly with a Bearer token.
- SolidJS and/or TanStack.
- No exception to the repository rules: `core` and `http` stay Workers-compatible, store limits
  are reported through `capabilities` (never a table scan), and new port behaviour starts with
  the contract suite.

## Decisions

### Framework: Vite + SolidJS + TanStack Router + TanStack Query

SolidJS and TanStack are complementary, not alternatives:

- **SolidJS** for rendering: small runtime, fine-grained reactivity, good for long event lists
  and large stack traces.
- **TanStack Router for Solid** for typed routes and search params (filters live in the URL,
  so views are shareable).
- **`@tanstack/solid-query`** for caching, refetch-on-focus, optimistic status updates and
  infinite cursor paging driven by the Sentry `Link` response header.
- **zod** schemas for response shapes, shared with `http` where a type already exists there.
- Charts (count sparkline, event histogram) as hand-written SVG; no charting dependency.

Not chosen: **TanStack Start** and **SolidStart**. Both assume a server runtime for SSR or
server functions, which reintroduces the BFF this design avoids. The UI is a pure static SPA.

### Hosting: static assets provisioned from the stack config

The UI is a build artifact plus a static-hosting component. Implemented in UI-c as a **platform
setting** (`awsLambda({ ui: { directory } })`, standalone `uiDirectory`), not as a `ui` selection:
the model has no port kind for it and a child's inputs cannot receive a build manifest (see
`INFRA_MODEL.md`). Hand-written HCL lives under `infra/modules/aws/static-site`, called by
`lambda-app`. `errtraq build` copies the UI into `<build>/ui` with a manifest; `errtraq infra
generate` verifies it. Open question 4 stays open for the owner: Cloudflare and GCP can choose
differently, and a `ui` selection would need a new port kind plus a build-input reference.

| Provider | Hosting | API routing |
|---|---|---|
| AWS | S3 (private, OAC) + CloudFront | CloudFront behavior `/api/0/*` to the API Lambda function URL |
| Cloudflare (M6) | Workers static assets | Same Worker or a route to the API Worker |
| GCP | Firebase Hosting, or GCS + Cloud CDN | Firebase rewrite / URL map to the Cloud Run API service |
| Standalone | Served by the standalone Node server from the built directory | Same process |

**Same origin by default.** Routing `/api/0/*` through the CDN to the API puts the UI and API
on one origin, so Bearer requests need no CORS preflight. A preflight is a billed function
invocation per request on every serverless platform, so this matters for cost, not only latency.

**CORS as the fallback** when the UI and API cannot share an origin: the API app gets an exact
origin allow-list from the stack config (never `*`), allows the `Authorization` header and sets a
long `Access-Control-Max-Age`. Ingest CORS is unrelated and unchanged.

**Not chosen:** serving the assets from the API function. Every asset request would become a
function invocation, and the assets would inflate the Workers and Lambda bundles.

The production build sets a strict Content-Security-Policy (`default-src 'self'`,
`connect-src` limited to the API origin and the IdP, no inline script), because the Bearer token
is reachable from page JavaScript.

### Authentication: Bearer passthrough in two phases

**Phase 1, API token.** The user pastes an existing organization API token
(`ProjectRepo.createToken` tokens, the same ones `sentry-cli` uses). The SPA keeps it in
`sessionStorage` and sends `Authorization: Bearer <token>`. This needs no backend change and
also lets the same UI point at Sentry or GlitchTip. Scope checks remain in `api.ts`; the UI
reads the token's scopes from the `whoami` route to hide actions it cannot perform.

**Phase 2, OIDC.** The SPA performs Authorization Code + PKCE against any OIDC provider
(Cognito, Google, Entra ID, Auth0, Keycloak) and sends the access token as the Bearer token.
The API distinguishes a JWT from an opaque API token and verifies it in `http` with
Web-standard APIs only: JWKS fetched with `fetch` and cached, signature checked with
WebCrypto, `iss` / `aud` / `exp` / `nbf` validated. (Implemented in UI-e with the JWKS cached in
per-instance memory rather than KV, so the API role needs no new KV grant; see ARCHITECTURE.md,
"Sign-in (UI-e)".)

Authorization maps claims to the existing token model, so there is no user table:

```ts
// stack config, illustrative
oidc: {
  issuer: "https://accounts.example.com",
  audience: "errtraq-ui",
  grants: [
    { claim: "groups", value: "errtraq-acme-admins", org: "acme", scopes: ["event:read", "event:write"] },
    { claim: "groups", value: "errtraq-acme-viewers", org: "acme", scopes: ["event:read"] },
  ],
}
```

The verified JWT becomes the same `{ orgId, scopes }` principal the handlers already receive,
so the route code does not change. A real user and membership model is deferred until a feature
needs per-user state (assignment, bookmarks, "seen by").

## API gaps

The current API (`packages/http/src/api.ts`, `release-routes.ts`) serves issue list (per project
and per organization), issue get / update, event list / latest / get, releases and `whoami`.
The UI also needs the following. All responses use Sentry's shapes, so a UI that only speaks
Sentry's `/api/0` doubles as a compatibility check against Sentry and GlitchTip. Bugsink has no
comparable public API, so parity with it is on features only.

| Gap | Used for | Notes |
|---|---|---|
| `GET /api/0/organizations/`, `/organizations/:org/projects/`, `/projects/:org/:project/` | Navigation, project switcher | Organization list is the token's single organization |
| Capabilities endpoint (or an extension on the `whoami` route) | Disabling search and filters the store cannot serve | Exposes `ActiveStore.capabilities` (`textSearch`, `lastSeenRangeOnOtherSort`, ...); the UI must not learn a limit from a 400 |
| Issue time-bucket counts (`statsPeriod`, `GET /issues/:id/stats` or the `stats` field on list items) | List sparklines, detail histogram | Already a `TODO.md` item (M5 / UI). See "Statistics" below |
| Tag facets (`GET /issues/:id/tags/`, `/tags/:key/values/`) | Detail tags panel | See "Statistics" below |
| Event neighbours (`/events/oldest/`, next / previous ids) | Event navigation | Keyset cursors already exist; this exposes the adjacent keys |
| Bulk `PUT /api/0/projects/:org/:project/issues/?id=...` | Bulk resolve / ignore | One CAS update per issue; partial failure reported per id |
| DSN key list `GET /projects/:org/:project/keys/` | Setup page | Read-only |
| API CORS (cross-origin deployments only) | See "Hosting" | Exact origins from the stack config |

Archived events (M4) need no UI-specific endpoint: `listByIssue` and event get are already
federated. The UI may badge events served from the archive, if the API marks them.

### Statistics

Bucketed counts and tag facets cannot be computed by scanning events on DynamoDB or Firestore,
and the no-table-scan rule forbids it, so they are maintained on the record path. Decided and
implemented in UI-d:

- **Counters are written inside the atomic `recordEvent` / `recordEvents` operation.** A
  duplicate event changes no counter; the numbers have the meaning of `Issue.count` (accepted
  insertions ever recorded, never decremented by retention, archival or erasure).
- **Time basis is `receivedAt`**, UTC; the API says so (`timeBasis: "receivedAt"` on the issue
  detail). Hourly buckets only, kept 31 days (removed by the `retention` cron on explicit-delete
  stores, by item TTL on DynamoDB). Daily series are summed from hourly buckets at read time.
- **Tag facets use a fixed allow-list**: `level`, `environment`, `release`, `server_name`,
  `browser.name`, `os.name`, `runtime.name`. The first three come from the stored event; the
  last four only from an explicit event tag of that name (the normalizer does not derive
  them from contexts). Never a `user.*` key, URL or IP, because facets are not reached by
  subject erasure. Values are cut to 200 characters; one never-decremented, non-expiring
  counter per `(issue, key, value)`; no cap on distinct values, the top-N read is index-served.
- **Port**: `ActiveStore.stats` (`IssueStatsRepo`: `series`, `tagFacets`, `tagValues`,
  `deleteBefore`), gated by `capabilities.issueStats` / `tagFacets`, both optional on the type
  so an adapter that has not implemented them (Firestore) keeps compiling and counts as `false`.
  A separate repo rather than `IssueRepo` methods because it is optional and has its own
  retention operation.
- **API**: issue list `statsPeriod=24h|14d` (zero-filled `[unixSeconds, count]` points from one
  batched call per page; other values 400; a store without the capability 400), issue detail
  `stats` (`24h`, `30d`) and `timeBasis`, `GET /issues/:id/tags/`, `/tags/:key/`,
  `/tags/:key/values/` (Link-paged). `totalValues` counts events as in Sentry; `uniqueValues`
  is the distinct-value count.
- **UI**: inline-SVG sparkline per list row (shown only when `issueStats`), histogram with a
  24h / 30d toggle and a tags panel with proportion bars on the issue page, and a paged
  values list per key. The text alternative and printed totals carry the numbers.

## Features

**Issue list**
- Status tabs: unresolved, resolved, ignored.
- Sort by last seen, first seen, count (the `IssueQuery` sorts).
- Environment and time range filters; free-text search only when `textSearch` is supported.
- Count sparkline per row; bulk selection and actions; infinite scroll on cursors.

**Issue detail**
- Header: title, culprit, level, first / last seen, count, status actions (resolve, resolve in
  next release, ignore, unresolve).
- Event histogram and tag facets (when supported).
- Latest event rendered in full:
  - exception chain with symbolicated frames, context lines, in-app filter and raw / minified toggle
  - breadcrumbs
  - request, user, contexts (OS, browser, runtime, device), SDK, tags
  - raw JSON view and download

**Events tab**
- Paged event list, prev / next / oldest / latest navigation, deep link per event.

**Releases**
- List and detail, deploys, artifact bundles (read-only).

**Project settings**
- DSN keys and an SDK setup snippet; retention and rate limits read-only.

**Out of scope:** performance / transactions, replays, profiles, custom dashboards, discover
queries, alert rules (a separate milestone), user management (until the user model exists).

## Package layout

```
packages/ui/                 @moriyoshi/errtraq-ui, Vite + Solid SPA, builds to dist/
  src/api/                   typed /api/0 client, zod schemas, Link-header cursor parsing
  src/auth/                  token login (phase 1), OIDC PKCE (phase 2)
  src/routes/                issue list, issue detail, event, releases, settings
  src/components/            stack trace, breadcrumbs, context tables, charts
(no ui-static adapter: hosting is a platform setting, see "Hosting")
infra/modules/aws/static-site/   S3 + CloudFront + OAC + /api/0 behavior
```

`packages/ui` depends on nothing from `core` at runtime except shared types; it must not pull
`core` services into the browser bundle.

## Slices

| Slice | Scope | Done when |
|---|---|---|
| **UI-a** | API surface: organization / project read routes, capabilities endpoint, event neighbours, bulk update, DSN key list, optional CORS | Route tests in `http`; contract suite extended where a repo method is new |
| **UI-b** | `packages/ui` skeleton: router, query client, token login, issue list and detail on the existing API | Playwright tests against `errtraq dev --stack stacks/local.ts`, seeded by the real `@sentry/node` SDK as in `pnpm e2e`; opt-in (skip without a browser) |
| **UI-c** (done) | Platform-owned hosting: `aws/static-site` module with same-origin routing, standalone server serves the build, `ingestUrl` and API CORS from the stack config | Infra-gen snapshot tests, `terraform validate` on the generated root |
| **UI-d** (done, Firestore pending) | Statistics: contract suite first, then memory, SQL and DynamoDB; sparkline, histogram and tag facets in the UI. Firestore declares both capabilities false until its own slice (`TODO(G-ui)`) | Contract suites pass on every store adapter that declares the capabilities |
| **UI-e** (done) | OIDC: JWT verification and claim-to-scope mapping in `http`, PKCE in the SPA | Unit tests with a locally generated JWKS; no network in the default test path |
| **UI-f** (done except public API URL and custom domain) | Bulk actions, keyboard navigation, releases pages, read-only settings, dark mode, raw event download; Sentry entry shapes, Accept-based SPA fallback on both hosts, project ID 0 rejected. Deferred behind UI-e: configured public API base URL, static-site custom domain (`TODO.md`, "UI-f follow-ups") | Unit tests, route tests, `pnpm e2e:ui`, CloudFront Function test, `pnpm infra:validate` |

Cloudflare and GCP hosting modules follow the platforms (M6, G-series), not this list.

## Open questions

1. Scheduling: start now with its own milestone letter, or after M3 / M4 / M6 settle.
2. ~~Statistics counters: inside the atomic record operation, or best-effort beside it.~~ Decided in UI-d: inside the atomic record operation.
3. First IdP to support and test: Cognito for AWS, Google for Cloud Run, or a generic OIDC
   provider only.
4. Whether `ui-static` is an adapter (one per provider) or a platform-owned component, given that
   the CDN routing is tied to the platform's API exposure.
