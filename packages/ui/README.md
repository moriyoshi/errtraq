# @moriyoshi/errtraq-ui

The errtraq web UI: a static SolidJS single-page app (Vite, TanStack Router and Query) that talks
to the Sentry-compatible `/api/0` with a Bearer token. Slice UI-b: token login, organization and
project selection, issue list, issue detail with events. Design: `.agents-docs/WEB_UI_DESIGN.md`.

## Run it

```sh
pnpm --filter @moriyoshi/errtraq-ui dev        # http://localhost:5173, proxies /api/0
pnpm --filter @moriyoshi/errtraq-ui build      # dist/ (strict CSP, no inline script or style)
pnpm --filter @moriyoshi/errtraq-ui preview
```

The dev and preview servers proxy `/api/0` to `http://127.0.0.1:8787`, the default address of
`errtraq dev --stack stacks/local.ts`. Override it with `ERRTRAQ_API_TARGET=http://host:port`.

For an API on another origin, build with `VITE_ERRTRAQ_API_BASE=https://api.example.com`. The CSP
`connect-src` then lists that origin, and the API must allow it through CORS (UI-a); the default
is same origin, which needs no CORS.

## Hosting the build

The build is static files; the API serves them on the same origin as `/api/0`, so no CORS is
needed. Build first (`pnpm --filter @moriyoshi/errtraq-ui build`), then point a stack at `dist/`.

**Standalone** (`errtraq dev` and the container). The platform setting `uiDirectory`, or the
environment variable `ERRTRAQ_UI_DIR` (which wins), names the directory; the same HTTP server then
serves it at `/`:

```sh
ERRTRAQ_UI_DIR=packages/ui/dist ERRTRAQ_DATA_DIR=.errtraq node packages/cli/dist/bin.js dev --stack stacks/local.ts
```

Real files are served as they are, and any other `GET` that is not under `/api/` and accepts
`text/html` gets `index.html` (the SPA routes), so deep links and reloads work. `/api/**` never
falls back. `assets/*` is `Cache-Control: public, max-age=31536000, immutable`, `index.html` is
`no-cache`, and HTML carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`Content-Security-Policy: frame-ancestors 'none'` (the `<meta>` CSP cannot set `frame-ancestors`).
A path never leaves the directory: dot segments (also encoded), dotfiles, backslashes and
symbolic links that resolve outside it are refused. A directory that is missing or has no
`index.html` fails at startup.

`stacks/local.ts` sets no `uiDirectory`; use the environment variable with it. In a stack of your
own, `uiDirectory: "/abs/path/to/dist"` (a literal path resolves against the working directory at
run time, and against the stack file's directory in `errtraq build`; prefer an absolute path or an
`env()` reference). When `errtraq build` sees a literal `uiDirectory` it copies the directory into
`<build>/ui/site`, adds `COPY ui/site /app/ui` and `ENV ERRTRAQ_UI_DIR=/app/ui` to the generated
Dockerfile, so the container serves the UI with no further setup.

A UI served from another origin needs `apiCorsOrigins: ["https://ui.example.com"]` (exact origins)
on the platform, and `VITE_ERRTRAQ_API_BASE` at build time.

**AWS Lambda.** The platform setting `ui: { directory: "../packages/ui/dist" }` (relative to the
stack file) hosts the build on a private S3 bucket behind CloudFront. `/api/0/*` is routed to the
API function URL on the same distribution, so the UI and the API share one origin and the Bearer
token reaches the API unchanged; ingest keeps its own function URL (the DSN host). See
`infra/modules/aws/README.md` and `stacks/aws-dynamodb-ui.ts`. `errtraq build` copies the
directory into `<build>/ui` with a manifest of paths, content types, cache rules and hashes;
`errtraq infra generate` verifies it and Terraform uploads exactly those files.

## Getting a token

Paste an API token on the login page. For a local server:

1. Start it: `ERRTRAQ_DATA_DIR=.errtraq node packages/cli/dist/bin.js dev --stack stacks/local.ts`
   (after `pnpm build`). It prints `API token: ...` on startup.
2. Or read the file it keeps: `$ERRTRAQ_DATA_DIR/api-token` (default `.errtraq/api-token`).
3. `errtraq token rotate --stack stacks/local.ts` issues a replacement. Deployed stacks print the
   bootstrap token from `errtraq bootstrap` (see `ARCHITECTURE.md`) or `errtraq token` commands.

The token lives in `sessionStorage` (this tab only). Any 401 clears it and returns to the login
page. Write actions (resolve, ignore) are hidden without the `event:write` scope, and free-text
search is hidden unless the API reports `errtraq.capabilities.textSearch`.

## Layout

- `src/api/`: typed client (`client.ts`, errors, `Link` cursor parsing), zod schemas, TanStack
  Query hooks. Every request goes through `createApiClient`.
- `src/auth/`: token session.
- `src/routes/`: code-based TanStack routes (no route generator).
- `src/components/`, `src/lib/`: stack trace, event view, frame collapsing, time formatting.

The package must not import `@moriyoshi/errtraq-core` or `-http` (`scripts/layering.mjs` checks
it): response schemas are self-contained and lenient, so the same UI works against Sentry and
GlitchTip. Event payload fields are untrusted and are only ever rendered as text.

## Tests

- Unit tests (`*.test.ts`, JSX-free) run in the root `pnpm test`.
- Browser test, opt-in: `pnpm e2e:ui`. It builds the repo and the UI, starts
  `errtraq dev --stack stacks/local.ts` on a temporary `ERRTRAQ_DATA_DIR`, seeds it with the real
  `@sentry/node` SDK, serves the build with `vite preview` and drives it with Playwright. It skips
  with a message when Chromium is missing; install it with
  `pnpm --filter @moriyoshi/errtraq-ui exec playwright install chromium`.
