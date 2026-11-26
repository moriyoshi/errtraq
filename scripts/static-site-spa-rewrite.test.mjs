import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The CloudFront Function of infra/modules/aws/static-site, run under Node the way main.tf
 * assembles it: the two lists, then spa-rewrite.js. Events follow the cloudfront-js-2.0 shape
 * (lower-case header names, `{ value }` or `{ multiValue: [{ value }] }`).
 */
const source = readFileSync(
  "infra/modules/aws/static-site/spa-rewrite.js",
  "utf8",
);
const handler = new Function(
  "ROOT_FILES",
  "PREFIXES",
  `${source}\nreturn handler;`,
)(["/favicon.svg", "/index.html"], ["/assets/"]);

const html = "text/html,application/xhtml+xml,*/*;q=0.8";
function run(uri, headers = {}) {
  const request = { uri, method: "GET", headers };
  const out = handler({ request });
  return { uri: out.uri, same: out === request };
}
const accept = (value) => ({ accept: { value } });

describe("static-site SPA rewrite (CloudFront Function)", () => {
  it("rewrites a navigation to a client-side route", () => {
    for (const uri of [
      "/organizations",
      // The OIDC redirect URI (the query string is not part of the CloudFront Function uri).
      "/auth/callback",
      "/acme/web/issues/42",
      "/acme/web/issues/42/events",
      // Dots in slugs and tag keys are not file extensions.
      "/acme/web.app/issues",
      "/acme/web/issues/42/tags/os.name",
      "/favicon.ico",
    ])
      expect(run(uri, accept(html)).uri).toBe("/index.html");
  });

  it("passes a non-navigation through, so a missing object is a 404", () => {
    for (const value of ["image/*,*/*;q=0.8", "*/*", "application/json"])
      for (const uri of ["/favicon.ico", "/missing.js", "/acme/web/issues/1"])
        expect(run(uri, accept(value))).toEqual({ uri, same: true });
    expect(run("/favicon.ico", {}).uri).toBe("/favicon.ico");
  });

  it("matches text/html case-insensitively, also in a repeated header", () => {
    expect(run("/x", accept("Text/HTML")).uri).toBe("/index.html");
    expect(
      run("/x", {
        accept: { value: "image/png", multiValue: [{ value: "text/html" }] },
      }).uri,
    ).toBe("/index.html");
  });

  it("never rewrites a file of the build, whatever the viewer accepts", () => {
    for (const uri of [
      "/favicon.svg",
      "/index.html",
      "/assets/index-abc123.js",
      "/assets/missing.js",
    ])
      expect(run(uri, accept(html))).toEqual({ uri, same: true });
  });

  it("matches a build directory with its trailing slash, so /assetsx is a route", () => {
    expect(run("/assetsx", accept(html)).uri).toBe("/index.html");
  });
});
