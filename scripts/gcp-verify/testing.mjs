/**
 * Offline test support for the probes: a routing `fetch` and a probe context over it. Not a
 * probe; imported by the `*.test.mjs` files only.
 */
import { createContext, loadConfig } from "./lib.mjs";

export const PROJECT = "example-project";
export const REGION = "europe-west1";

/** `routes`: [method, RegExp over the URL, (url, init, match) => Response | object]. First match wins. */
export function routerFetch(routes, log = []) {
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    log.push({ method, url, init });
    for (const [wantedMethod, pattern, handler] of routes) {
      if (wantedMethod !== method && wantedMethod !== "*") continue;
      const match = pattern.exec(url);
      if (!match) continue;
      const result = await handler(url, init, match);
      if (result instanceof Response) return result;
      const { status = 200, body = {}, headers = {} } = result ?? {};
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(status === 204 ? null : text, { status, headers });
    }
    return new Response(
      JSON.stringify({ error: { message: `no route for ${method} ${url}` } }),
      { status: 599 },
    );
  };
  fetcher.log = log;
  return fetcher;
}

export async function testContext({
  fetch,
  flags = {},
  env = {},
  outputs = {},
  deps = {},
} = {}) {
  const lines = [];
  const config = loadConfig(
    { project: PROJECT, region: REGION, "run-id": "abc123", ...flags },
    env,
  );
  let time = 0;
  const ctx = await createContext(config, {
    fetch,
    env,
    outputs,
    print: (line) => lines.push(line),
    auth: {
      accessToken: async () => "test-access-token",
      idToken: async (audience, options) =>
        `id-${audience}-${options?.as ?? "self"}`,
      impersonatedAccessToken: async (email) => `access-as-${email}`,
    },
    clock: {
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
    },
    ...deps,
  });
  return { ctx, lines, output: () => lines.join("\n") };
}

export const dataOf = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64");
