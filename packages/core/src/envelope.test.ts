import { describe, expect, it } from "vitest";
import {
  InvalidEnvelopeError,
  parseDsnKey,
  parseEnvelope,
  parseEventPayload,
  wrapStorePayload,
} from "./envelope.js";

const encode = (text: string) => new TextEncoder().encode(text);
describe("Sentry envelope parsing", () => {
  it("parses byte-length-delimited UTF-8 and newline items", () => {
    const payload = encode('{"message":"é\\nhello"}');
    const first = encode(
      `{"event_id":"abc"}\n{"type":"event","length":${payload.length}}\n`,
    );
    const last = encode('\n{"type":"session"}\n{}\n');
    const body = new Uint8Array(first.length + payload.length + last.length);
    body.set(first);
    body.set(payload, first.length);
    body.set(last, first.length + payload.length);
    const result = parseEnvelope(body);
    expect(result.items).toHaveLength(2);
    expect(
      parseEventPayload(result.items[0]?.payload ?? new Uint8Array()),
    ).toEqual({ message: "é\nhello" });
    expect(result.items[1]?.headers.type).toBe("session");
  });
  it("rejects malformed boundaries and JSON", () => {
    for (const source of [
      '{}\n{"type":"event","length":8}\nx',
      '{}\n{"type":"event","length":1}\nxBAD',
      '{}\n{"length":0}\n',
    ])
      expect(() => parseEnvelope(encode(source))).toThrow(InvalidEnvelopeError);
  });
  it("wraps the legacy payload with byte length", () => {
    const payload = encode('{"message":"é"}');
    const result = parseEnvelope(wrapStorePayload(payload, "abc"));
    expect(result.headers.event_id).toBe("abc");
    expect(result.items[0]?.payload).toEqual(payload);
  });
  it("extracts the query or Sentry authorization key", () => {
    expect(
      parseDsnKey('Sentry sentry_version=7, sentry_key="key-1"', null),
    ).toBe("key-1");
    expect(parseDsnKey("Sentry sentry_key=header", "query")).toBe("query");
    expect(parseDsnKey("Bearer nope", null)).toBeNull();
  });
});
