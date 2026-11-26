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

## Using it (UI-f)

- **Issues**: status tabs, sort, search (when the store supports it), per-row sparkline. With the
  `event:write` scope each row has a checkbox, a "select all loaded" box and a bar with Resolve /
  Ignore / Unresolve. A selection is sent in batches of at most 100 ids
  (`PUT /projects/{org}/{project}/issues/?id=...`); the rows leave the list at once and come back
  if their batch fails, and a partial failure names how many landed. Failed issues stay selected.
- **Releases** tab: the project's releases (version, created, released, deploys; "new issues" is
  always 0 because errtraq does not attribute issues to releases) and a release page with its
  deploys and artifact bundles (read-only, from `GET .../artifact-bundles/?query=<version>`).
- **Settings** tab (read-only): DSN keys with a Copy button (Clipboard API, hidden-textarea
  fallback), SDK snippets for browser JavaScript, Node and Python, `sentry-cli` environment
  variables (never a token) and retention and rate limits. A key without a `dsn` means the server
  has no public ingest URL: set `publicUrl` (standalone) or `publicIngestUrl` (AWS Lambda).
- **Theme**: System / Light / Dark in the header. System follows `prefers-color-scheme`; the
  other two set `data-theme` on `<html>`. The choice is kept in `localStorage` (best effort: a
  private window falls back to System). Colours are tokens in `src/styles.css`;
  `src/lib/contrast.test.ts` checks WCAG AA for text and 3:1 for focus rings and chart marks in
  both themes.
- **Raw JSON**: the event page's "Download JSON" saves the event through a `Blob` URL (revoked
  right after the click); the build's CSP allows it.

### Keyboard shortcuts

Ignored while focus is in an input, textarea, select or contenteditable element, and with Ctrl,
Alt or Cmd held. `?` lists them in a dialog.

| Keys | Where | Action |
|---|---|---|
| `j` / `k` | issue list | focus the next / previous row (clamped, first row when none) |
| `Enter` / `o` | issue list | open the focused issue (`Enter` is left to a focused link or button) |
| `x` | issue list | select / deselect the focused row |
| `r` / `i` / `u` | issue list | resolve / ignore / unresolve the selection, or the focused row when nothing is selected |
| `r` / `i` / `u` | issue page | the same for the open issue (only the transitions its buttons offer) |
| `/` | issue list | focus the search box (when there is one) |
| `[` / `]` | issue page | older / newer event |
| `?` | everywhere | keyboard shortcut help |

ARIA: the list stays a plain list, real DOM focus follows `j` / `k` (rows have `tabindex="-1"`),
and the focused row carries `aria-current="true"` plus a bar on its edge (not colour alone).
Selection is the row's native checkbox, so it is announced as checked. The bulk bar is a
`fieldset` with `aria-busy` while a request runs; keys are ignored until it finishes. A listbox
or grid role was not used because rows hold links and checkboxes, which those roles forbid.

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

## Sign-in (UI-e)

The API accepts three kinds of credential, always checked in this order: an `errtraq_` API token
(Bearer), then the configured identity-aware proxy assertion, then a Bearer JWT from an OpenID
Connect provider. The UI supports all three.

**API token** (the default): paste a token, as before.

**Single sign-on (Authorization Code + PKCE).** Build with:

| Variable | Meaning |
|---|---|
| `VITE_ERRTRAQ_OIDC_ISSUER` | Issuer URL, exactly as the provider reports it. Unset means token login only. |
| `VITE_ERRTRAQ_OIDC_CLIENT_ID` | The SPA (public) client ID. |
| `VITE_ERRTRAQ_OIDC_SCOPES` | Default `openid email profile`. |
| `VITE_ERRTRAQ_OIDC_TOKEN` | `access` (default) or `id`: which token is sent as the Bearer token. |
| `VITE_ERRTRAQ_OIDC_CONNECT_SRC` | Extra origins for the CSP `connect-src` (a token endpoint on another host, for example a Cognito domain). The issuer origin is added automatically. |

The SPA reads `/.well-known/openid-configuration` (the document must report the same issuer),
redirects to the authorization endpoint with a PKCE S256 challenge, `state` and `nonce` (kept in
`sessionStorage` for the round trip only), and receives the code at `${origin}/auth/callback`.
It checks `state`, exchanges the code, checks the ID token's `nonce` (the signature is not
checked in the browser; the API verifies the Bearer), stores only the Bearer token and its expiry
in `sessionStorage`, and removes `code` and `state` from the address bar. There are no refresh
tokens: when the token expires, or the API answers 401, the app returns to the login page. Log
out clears the session and, when the provider publishes `end_session_endpoint`, goes there with
`client_id` and `post_logout_redirect_uri=${origin}/login`.

Register the redirect URI `${origin}/auth/callback` (and the post-logout URI `${origin}/login`)
and create a **public** client (no client secret):

- **Cognito**: user pool app client without a secret, "Authorization code grant", scopes
  `openid email profile`. The issuer is `https://cognito-idp.<region>.amazonaws.com/<pool-id>`;
  the token endpoint is on the pool domain, so set `VITE_ERRTRAQ_OIDC_CONNECT_SRC` to
  `https://<domain>.auth.<region>.amazoncognito.com`. Access tokens carry `client_id`, no `aud`,
  and `token_use: "access"`: configure the API with `audienceClaim: "client_id"`,
  `audience: <client id>`, `tokenUse: { claim: "token_use", value: "access" }`, and group grants on
  `cognito:groups`. Cognito's discovery document may not publish
  `end_session_endpoint` (its logout endpoint uses different parameter names; this was not
  verified in UI-e); without one, log out returns to the login page.
- **Entra ID**: "Single-page application" platform with the redirect URI. Use the v2.0 issuer
  `https://login.microsoftonline.com/<tenant>/v2.0` and an application ID URI as the API
  audience (expose an API scope and request it in `VITE_ERRTRAQ_OIDC_SCOPES`), `access` token.
- **Auth0**: "Single Page Application", an API with an identifier as the audience; group claims
  need a custom namespaced claim or an Action.
- **Keycloak**: client with "Client authentication" off and "Standard flow" on, PKCE method
  S256.
- **Google**: not supported for the SPA flow in this slice. Google issues opaque access tokens,
  so the ID token would have to be sent (`VITE_ERRTRAQ_OIDC_TOKEN=id`); Google "Web application"
  clients are normally exchanged with a client secret, which a SPA cannot hold. Google's pages
  mark `client_secret` as "Optional" for the token request
  (https://developers.google.com/identity/protocols/oauth2/web-server) and recommend the
  authorization code flow with PKCE for browser apps
  (https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow), but no
  public-client path for a plain SPA is documented there, and this slice did not test one. On
  Google Cloud use Identity-Aware Proxy (proxy mode below).

**Identity-aware proxy.** Build with `VITE_ERRTRAQ_AUTH=proxy` (and optionally
`VITE_ERRTRAQ_PROXY_LOGOUT_URL`, the proxy's sign-out URL). There is no login page and no stored
token. The app calls `whoami` on start and sends the proxy's session cookie with its requests
(`credentials: "same-origin"` instead of `"omit"`: the cookie is for the same origin the proxy
serves, so the browser sends it, and it never goes to another origin). Writes carry
`X-Errtraq-Csrf: 1`. On a 401 the page reloads once so the proxy can run its own sign-in; a
second 401 within a minute shows an error instead of looping.

The CSP is built into `index.html` at build time; the issuer and extra origins above are added to
`connect-src`.
