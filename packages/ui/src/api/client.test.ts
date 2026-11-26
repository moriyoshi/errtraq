import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApiClient } from "./client";
import { ApiError } from "./errors";

function setup(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
  token: string | null = "tok",
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const onUnauthorized = vi.fn();
  const client = createApiClient({
    base: "https://api.test",
    getToken: () => token,
    onUnauthorized,
    fetch: (async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return respond(url, init);
    }) as typeof fetch,
  });
  return { client, calls, onUnauthorized };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });

describe("api client", () => {
  it("sends the Bearer token and query, and parses the response", async () => {
    const { client, calls } = setup(() => json([{ id: "1" }]));
    const data = await client.get(
      "/api/0/x/",
      z.array(z.object({ id: z.string() })),
      {
        query: { a: "b c", skip: undefined, empty: "" },
      },
    );
    expect(data).toEqual([{ id: "1" }]);
    expect(calls[0]?.url.toString()).toBe("https://api.test/api/0/x/?a=b+c");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("returns the next cursor from the Link header", async () => {
    const { client } = setup(() =>
      json([], {
        headers: {
          Link: '<u>; rel="next"; results="true"; cursor="n1"',
        },
      }),
    );
    expect((await client.page("/p", z.array(z.unknown()))).next).toBe("n1");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "notFound"],
    [400, "badRequest"],
    [500, "server"],
  ])("maps %i to %s and keeps the detail", async (status, kind) => {
    const { client } = setup(() => json({ detail: "why" }, { status }));
    const error = await client.get("/p", z.unknown()).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind, status, message: "why" });
  });

  it("calls onUnauthorized on 401 unless quiet", async () => {
    const { client, onUnauthorized } = setup(() => json({}, { status: 401 }));
    await client.get("/p", z.unknown()).catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await client.get("/p", z.unknown(), { quiet401: true }).catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("falls back to the status text for a non-JSON error body", async () => {
    const { client } = setup(
      () => new Response("<html>", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(client.get("/p", z.unknown())).rejects.toMatchObject({
      kind: "server",
      message: "Bad Gateway",
    });
  });

  it("reports an unreachable API and a schema mismatch", async () => {
    const down = setup(() => {
      throw new TypeError("fetch failed");
    });
    await expect(down.client.get("/p", z.unknown())).rejects.toMatchObject({
      kind: "network",
    });
    const odd = setup(() => json({ id: 5 }));
    await expect(
      odd.client.get("/p", z.object({ id: z.string() })),
    ).rejects.toMatchObject({ kind: "parse" });
  });

  it("sends a JSON body with PUT", async () => {
    const { client, calls } = setup(() => json({}));
    await client.get("/p", z.unknown(), {
      method: "PUT",
      body: { status: "resolved" },
    });
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe('{"status":"resolved"}');
  });
});
