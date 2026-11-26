/**
 * SDK and `sentry-cli` setup snippets for the settings page. Every value that reaches a snippet
 * is quoted for its language, so a DSN or slug with a quote, backslash, `$` or newline cannot
 * break out of the literal. A token never appears: `sentry-cli` gets a placeholder.
 */

/** A double-quoted JavaScript / JSON string literal (also valid in Python for these inputs). */
export function stringLiteral(value: string): string {
  // JSON.stringify escapes quotes, backslashes and control characters; U+2028 / U+2029 are
  // escaped too, which older JavaScript engines need inside a literal.
  return JSON.stringify(value)
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** A POSIX shell single-quoted word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface SnippetSet {
  browser: string;
  node: string;
  python: string;
}

export function sdkSnippets(dsn: string): SnippetSet {
  const literal = stringLiteral(dsn);
  return {
    browser: `npm install @sentry/browser

import * as Sentry from "@sentry/browser";

Sentry.init({
  dsn: ${literal},
});
`,
    node: `npm install @sentry/node

// Run this before anything else is imported.
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: ${literal},
});
`,
    python: `pip install sentry-sdk

import sentry_sdk

sentry_sdk.init(
    dsn=${literal},
)
`,
  };
}

export function cliSnippet(args: {
  url: string;
  org: string;
  project: string;
}): string {
  return `export SENTRY_URL=${shellQuote(args.url)}
export SENTRY_ORG=${shellQuote(args.org)}
export SENTRY_PROJECT=${shellQuote(args.project)}
# An API token with event:read and event:write, from your errtraq operator. Keep it out of the repository.
export SENTRY_AUTH_TOKEN=${shellQuote("<your API token>")}

sentry-cli releases new "$VERSION"
sentry-cli sourcemaps upload ./dist
`;
}
