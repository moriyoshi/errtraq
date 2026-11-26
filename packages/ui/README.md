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
