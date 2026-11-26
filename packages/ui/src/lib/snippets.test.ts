import { describe, expect, it } from "vitest";
import { cliSnippet, sdkSnippets, shellQuote, stringLiteral } from "./snippets";

const DSN = "https://abc123@ingest.example.com/7";

describe("snippets", () => {
  it("embeds the DSN in each SDK snippet", () => {
    const s = sdkSnippets(DSN);
    expect(s.browser).toContain(`dsn: "${DSN}"`);
    expect(s.node).toContain(`dsn: "${DSN}"`);
    expect(s.python).toContain(`dsn="${DSN}"`);
    expect(s.browser).toContain("@sentry/browser");
    expect(s.node).toContain("@sentry/node");
    expect(s.python).toContain("sentry_sdk.init");
  });

  it("escapes quotes, backslashes, newlines and line separators in a literal", () => {
    const nasty = 'a"b\\c\nd e</script>';
    const literal = stringLiteral(nasty);
    expect(JSON.parse(literal.replaceAll("\\u2028", " "))).toBe(nasty);
    expect(literal).not.toContain("\n");
    expect(literal).not.toContain(" ");
    // The hostile value stays inside one literal in every SDK snippet.
    for (const code of Object.values(sdkSnippets(nasty)))
      expect(code).toContain(literal);
  });

  it("quotes shell words so $, backticks and quotes stay inert", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's $HOME `x`")).toBe(`'it'\\''s $HOME \`x\`'`);
  });

  it("builds the sentry-cli setup without a token", () => {
    const text = cliSnippet({
      url: "https://errtraq.example.com",
      org: "acme",
      project: "web'; rm -rf /; echo '",
    });
    expect(text).toContain("export SENTRY_URL='https://errtraq.example.com'");
    expect(text).toContain("export SENTRY_ORG='acme'");
    expect(text).toContain(
      `export SENTRY_PROJECT='web'\\''; rm -rf /; echo '\\'''`,
    );
    expect(text).toContain("<your API token>");
    expect(text).not.toMatch(/errtraq_[A-Za-z0-9]{6,}/);
  });
});
