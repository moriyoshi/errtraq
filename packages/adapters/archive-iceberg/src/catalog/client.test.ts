import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CatalogAlreadyExistsError,
  CatalogAuthError,
  CatalogCommitConflictError,
  CatalogCommitStateUnknownError,
  CatalogNotFoundError,
  CatalogRequestError,
  CatalogTransientError,
  IcebergRestCatalog,
} from "./index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}
type Handler = (request: Recorded) => Response | Promise<Response> | undefined;
function fakeFetch(handlers: Handler[]) {
  const requests: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(request);
    for (const handler of handlers) {
      const response = await handler(request);
      if (response) return response;
    }
    return new Response("unexpected request", { status: 599 });
  }) as typeof fetch;
  return { fetch: impl, requests };
}
const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
const route =
  (method: string, path: string, respond: (r: Recorded) => Response): Handler =>
  (r) =>
    r.method === method && r.url.pathname === path ? respond(r) : undefined;

const BASE = "http://catalog.example.test/catalog";
const PREFIX = "0a1b2c3d-0000-4000-8000-000000000001";

describe("getConfig", () => {
  it("sends the warehouse and applies the prefix and uri override to later calls", async () => {
    const { fetch, requests } = fakeFetch([
      route("GET", "/catalog/v1/config", () =>
        json(fixture("config-lakekeeper")),
      ),
      route(
        "GET",
        `/catalog/v1/${PREFIX}/namespaces/errtraq/tables/events`,
        () => json(fixture("load-table")),
      ),
    ]);
    const catalog = new IcebergRestCatalog({
      uri: `${BASE}/`,
      warehouse: "errtraq",
      fetch,
    });
    const config = await catalog.getConfig();
    expect(config.overrides.prefix).toBe(PREFIX);
    expect(await catalog.prefix()).toBe(PREFIX);
    expect(requests[0]?.url.search).toBe("?warehouse=errtraq");
    await catalog.loadTable(["errtraq"], "events");
    expect(requests[1]?.url.href).toBe(
      `${BASE}/v1/${PREFIX}/namespaces/errtraq/tables/events`,
    );
    // The config is fetched once.
    await catalog.loadTable(["errtraq"], "events");
    expect(
      requests.filter((r) => r.url.pathname.endsWith("/v1/config")),
    ).toHaveLength(1);
  });

  it("lets overrides win over defaults and keeps an encoded prefix as sent", async () => {
    const { fetch, requests } = fakeFetch([
      route("GET", "/iceberg/v1/config", () =>
        json(
          JSON.stringify({
            defaults: { prefix: "from-defaults", x: "1" },
            overrides: {
              prefix: "arn%3Aaws%3As3tables%3Aus-east-1%3A0%3Abucket%2Fb",
            },
          }),
        ),
      ),
      route(
        "POST",
        "/iceberg/v1/arn%3Aaws%3As3tables%3Aus-east-1%3A0%3Abucket%2Fb/namespaces",
        () => json("{}"),
      ),
    ]);
    const catalog = new IcebergRestCatalog({
      uri: "https://s3tables.example.test/iceberg",
      fetch,
    });
    expect(await catalog.properties()).toMatchObject({ x: "1" });
    await catalog.createNamespace(["errtraq"]);
    expect(requests[1]?.url.pathname).toBe(
      "/iceberg/v1/arn%3Aaws%3As3tables%3Aus-east-1%3A0%3Abucket%2Fb/namespaces",
    );
  });

  it("works without a prefix and retries the config after a failure", async () => {
    let fail = true;
    const { fetch } = fakeFetch([
      route("GET", "/v1/config", () => {
        if (fail) return json("{}", 503);
        return json(JSON.stringify({ defaults: {}, overrides: {} }));
      }),
      route("GET", "/v1/namespaces/a%1Fb/tables/t", () =>
        json(fixture("load-table")),
      ),
    ]);
    const catalog = new IcebergRestCatalog({
      uri: "http://c.example.test",
      fetch,
    });
    await expect(catalog.getConfig()).rejects.toBeInstanceOf(
      CatalogTransientError,
    );
    fail = false;
    await catalog.loadTable(["a", "b"], "t");
  });
});

describe("tables and namespaces", () => {
  const lakekeeper = (...extra: Handler[]) =>
    fakeFetch([
      route("GET", "/catalog/v1/config", () =>
        json(fixture("config-lakekeeper")),
      ),
      ...extra,
    ]);

  it("loadTable keeps 64-bit snapshot ids exact", async () => {
    const { fetch } = lakekeeper(
      route(
        "GET",
        `/catalog/v1/${PREFIX}/namespaces/errtraq/tables/events`,
        () => json(fixture("load-table")),
      ),
    );
    const result = await new IcebergRestCatalog({ uri: BASE, fetch }).loadTable(
      ["errtraq"],
      "events",
    );
    expect(result.metadata["current-snapshot-id"]).toBe("8272731873417586179");
    expect(result.metadata.snapshots?.map((s) => s["snapshot-id"])).toEqual([
      "5418930217356184321",
      "8272731873417586179",
    ]);
    expect(result.metadata.refs?.main?.["snapshot-id"]).toBe(
      "8272731873417586179",
    );
    // A numeral inside a string is not rewritten, and safe integers stay numbers.
    expect(result.metadata.snapshots?.[1]?.summary?.note).toBe(
      "9999999999999999999",
    );
    expect(result.metadata["last-sequence-number"]).toBe(2);
    expect(result.config?.["s3.endpoint"]).toBe("http://winterbaume:5555");
  });

  it("loadTable maps 404 to CatalogNotFoundError carrying the REST body", async () => {
    const { fetch } = lakekeeper(
      route(
        "GET",
        `/catalog/v1/${PREFIX}/namespaces/errtraq/tables/events`,
        () => json(fixture("error-no-such-table"), 404),
      ),
    );
    const error = await new IcebergRestCatalog({ uri: BASE, fetch })
      .loadTable(["errtraq"], "events")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogNotFoundError);
    expect((error as CatalogNotFoundError).body).toEqual({
      message: "Table does not exist: errtraq.events",
      type: "NoSuchTableException",
      code: 404,
    });
    expect((error as CatalogNotFoundError).retryable).toBe(false);
  });

  it("createNamespace posts the namespace and tolerates an existing one on request", async () => {
    let exists = false;
    const { fetch, requests } = lakekeeper(
      route("POST", `/catalog/v1/${PREFIX}/namespaces`, () =>
        exists ? json(fixture("error-namespace-exists"), 409) : json("{}"),
      ),
    );
    const catalog = new IcebergRestCatalog({ uri: BASE, fetch });
    expect(await catalog.createNamespace(["errtraq"], { owner: "x" })).toEqual({
      created: true,
    });
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
      namespace: ["errtraq"],
      properties: { owner: "x" },
    });
    exists = true;
    await expect(catalog.createNamespace(["errtraq"])).rejects.toBeInstanceOf(
      CatalogAlreadyExistsError,
    );
    expect(
      await catalog.createNamespace(["errtraq"], {}, { ifNotExists: true }),
    ).toEqual({
      created: false,
    });
  });

  it("createTable posts the request and the access delegation header only when asked", async () => {
    const { fetch, requests } = lakekeeper(
      route("POST", `/catalog/v1/${PREFIX}/namespaces/errtraq/tables`, () =>
        json(fixture("load-table")),
      ),
    );
    const catalog = new IcebergRestCatalog({ uri: BASE, fetch });
    const request = {
      name: "events",
      schema: { type: "struct", "schema-id": 0, fields: [] },
      properties: { "format-version": "2" },
    };
    await catalog.createTable(["errtraq"], request);
    await catalog.createTable(["errtraq"], request, {
      accessDelegation: "vended-credentials",
    });
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual(request);
    expect(requests[1]?.headers.has("x-iceberg-access-delegation")).toBe(false);
    expect(requests[2]?.headers.get("x-iceberg-access-delegation")).toBe(
      "vended-credentials",
    );
  });

  it("commit writes exact 64-bit literals for the three supported updates", async () => {
    const { fetch, requests } = lakekeeper(
      route(
        "POST",
        `/catalog/v1/${PREFIX}/namespaces/errtraq/tables/events`,
        () =>
          json(
            JSON.stringify({
              "metadata-location": "s3://b/m.json",
              metadata: { "format-version": 2, "table-uuid": "u" },
            }),
          ),
      ),
    );
    const catalog = new IcebergRestCatalog({ uri: BASE, fetch });
    const result = await catalog.commit(["errtraq"], "events", {
      requirements: [
        { type: "assert-table-uuid", uuid: "u" },
        {
          type: "assert-ref-snapshot-id",
          ref: "main",
          "snapshot-id": "8272731873417586179",
        },
        { type: "assert-ref-snapshot-id", ref: "audit", "snapshot-id": null },
      ],
      updates: [
        {
          action: "set-properties",
          updates: { "history.expire.max-snapshot-age-ms": "1000" },
        },
        {
          action: "remove-snapshots",
          "snapshot-ids": ["5418930217356184321", 7n],
        },
        {
          action: "set-snapshot-ref",
          "ref-name": "main",
          type: "branch",
          "snapshot-id": "8272731873417586179",
        },
      ],
    });
    expect(result["metadata-location"]).toBe("s3://b/m.json");
    const body = requests[1]?.body ?? "";
    expect(body).toContain('"snapshot-ids":[5418930217356184321,7]');
    expect(body).toContain(
      '"ref-name":"main","type":"branch","snapshot-id":8272731873417586179',
    );
    expect(body).toContain('"ref":"main","snapshot-id":8272731873417586179');
    expect(body).toContain('"ref":"audit","snapshot-id":null');
    expect(body).toContain(
      '"identifier":{"namespace":["errtraq"],"name":"events"}',
    );
    expect(requests[1]?.headers.get("content-type")).toBe("application/json");
  });

  it("maps a commit 409 to a retryable conflict and 5xx to an unknown commit state", async () => {
    let status = 409;
    const { fetch } = lakekeeper(
      route(
        "POST",
        `/catalog/v1/${PREFIX}/namespaces/errtraq/tables/events`,
        () =>
          status === 409
            ? json(fixture("error-commit-conflict"), 409)
            : json("{}", status),
      ),
    );
    const catalog = new IcebergRestCatalog({ uri: BASE, fetch });
    const request = { requirements: [], updates: [] };
    const conflict = await catalog
      .commit(["errtraq"], "events", request)
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(CatalogCommitConflictError);
    expect((conflict as CatalogCommitConflictError).retryable).toBe(true);
    expect((conflict as CatalogCommitConflictError).body?.type).toBe(
      "CommitFailedException",
    );
    status = 503;
    const unknown = await catalog
      .commit(["errtraq"], "events", request)
      .catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(CatalogCommitStateUnknownError);
    expect((unknown as CatalogCommitStateUnknownError).retryable).toBe(false);
    status = 400;
    await expect(
      catalog.commit(["errtraq"], "events", request),
    ).rejects.toBeInstanceOf(CatalogRequestError);
  });

  it("keeps a non-envelope error body as rawBody and treats a dropped connection as transient", async () => {
    let drop = false;
    const { fetch } = lakekeeper(
      (r) => {
        if (
          drop &&
          r.method === "GET" &&
          r.url.pathname.endsWith("/tables/events")
        )
          throw new TypeError("socket hang up");
        return undefined;
      },
      route(
        "GET",
        `/catalog/v1/${PREFIX}/namespaces/errtraq/tables/events`,
        () => new Response("<html>bad gateway</html>", { status: 502 }),
      ),
    );
    const catalog = new IcebergRestCatalog({ uri: BASE, fetch });
    const bad = await catalog
      .loadTable(["errtraq"], "events")
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(CatalogTransientError);
    expect((bad as CatalogTransientError).rawBody).toContain("bad gateway");
    drop = true;
    await expect(
      catalog.loadTable(["errtraq"], "events"),
    ).rejects.toBeInstanceOf(CatalogTransientError);
  });

  it("rejects malformed namespaces and table names before sending", async () => {
    const { fetch, requests } = fakeFetch([]);
    const catalog = new IcebergRestCatalog({ uri: BASE, fetch });
    await expect(catalog.loadTable([], "t")).rejects.toThrow(TypeError);
    await expect(catalog.loadTable(["a"], "")).rejects.toThrow(TypeError);
    await expect(catalog.loadTable(["a\u001fb"], "t")).rejects.toThrow(
      TypeError,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("authentication", () => {
  const protectedCatalog = (token: () => string) =>
    [
      route("GET", "/catalog/v1/config", () =>
        json(fixture("config-lakekeeper")),
      ),
      route(
        "GET",
        `/catalog/v1/${PREFIX}/namespaces/errtraq/tables/events`,
        () => json(fixture("load-table")),
      ),
    ].map(
      (handler): Handler =>
        (r) => {
          if (r.headers.get("authorization") !== `Bearer ${token()}`)
            return json(
              JSON.stringify({
                error: {
                  message: "no",
                  type: "NotAuthorizedException",
                  code: 401,
                },
              }),
              401,
            );
          return handler(r);
        },
    );

  it("sends no authorization header with auth none", async () => {
    const { fetch, requests } = fakeFetch([
      route("GET", "/v1/config", () => json("{}")),
    ]);
    await new IcebergRestCatalog({
      uri: "http://c.example.test",
      fetch,
    }).getConfig();
    expect(requests[0]?.headers.has("authorization")).toBe(false);
  });

  it("bearer resolves a lazy secret per request and surfaces 401 as an auth error", async () => {
    const { fetch, requests } = fakeFetch(protectedCatalog(() => "s3cret"));
    const good = new IcebergRestCatalog({
      uri: BASE,
      auth: { type: "bearer", token: async () => "s3cret" },
      fetch,
    });
    await good.loadTable(["errtraq"], "events");
    expect(
      requests.every((r) => r.headers.get("authorization") === "Bearer s3cret"),
    ).toBe(true);
    const bad = new IcebergRestCatalog({
      uri: BASE,
      auth: { type: "bearer", token: "nope" },
      fetch,
    });
    await expect(bad.getConfig()).rejects.toBeInstanceOf(CatalogAuthError);
  });

  describe("oauth2 client credentials", () => {
    function oauthFetch(
      options: { token?: () => string; expiresIn?: number } = {},
    ) {
      let issued = 0;
      const tokenFor = options.token ?? (() => `tok-${issued}`);
      const state = fakeFetch([
        route("POST", "/token", () => {
          issued++;
          return json(
            JSON.stringify({
              access_token: tokenFor(),
              token_type: "bearer",
              expires_in: options.expiresIn ?? 300,
            }),
          );
        }),
        ...protectedCatalog(tokenFor),
      ]);
      return { ...state, issued: () => issued };
    }
    const authConfig = {
      type: "oauth2" as const,
      clientId: "errtraq",
      clientSecret: () => "shh",
      tokenEndpoint: "https://auth.example.test/token",
    };

    it("posts the client credentials form and caches the token until it nears expiry", async () => {
      let now = 1_000_000;
      const { fetch, requests, issued } = oauthFetch({ expiresIn: 300 });
      const catalog = new IcebergRestCatalog({
        uri: BASE,
        auth: authConfig,
        fetch,
        now: () => now,
      });
      await catalog.loadTable(["errtraq"], "events");
      await catalog.loadTable(["errtraq"], "events");
      expect(issued()).toBe(1);
      const tokenRequest = requests.find((r) => r.url.pathname === "/token");
      expect(tokenRequest?.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(
        Object.fromEntries(new URLSearchParams(tokenRequest?.body)),
      ).toEqual({
        grant_type: "client_credentials",
        client_id: "errtraq",
        client_secret: "shh",
        scope: "catalog",
      });
      now += 250_000; // inside the 60 s refresh skew of the 300 s lifetime
      await catalog.loadTable(["errtraq"], "events");
      expect(issued()).toBe(2);
    });

    it("shares one in-flight refresh between concurrent calls", async () => {
      const { fetch, issued } = oauthFetch();
      const catalog = new IcebergRestCatalog({
        uri: BASE,
        auth: authConfig,
        fetch,
      });
      await Promise.all([
        catalog.getConfig(),
        catalog.getConfig(),
        catalog.prefix(),
      ]);
      expect(issued()).toBe(1);
    });

    it("refreshes once on a 401 from a revoked token", async () => {
      let valid = "tok-1";
      let issued = 0;
      const { fetch } = fakeFetch([
        route("POST", "/token", () => {
          issued++;
          return json(
            JSON.stringify({ access_token: `tok-${issued}`, expires_in: 3600 }),
          );
        }),
        ...protectedCatalog(() => valid),
      ]);
      const catalog = new IcebergRestCatalog({
        uri: BASE,
        auth: authConfig,
        fetch,
      });
      await catalog.loadTable(["errtraq"], "events");
      valid = "tok-2"; // server revoked tok-1
      await catalog.loadTable(["errtraq"], "events");
      expect(issued).toBe(2);
    });

    it("discovers oauth2-server-uri from the catalog config, then falls back to the spec path", async () => {
      const seen: string[] = [];
      const { fetch } = fakeFetch([
        route("POST", "/iceberg/v1/oauth/tokens", (r) => {
          seen.push(r.url.href);
          return json(fixture("token"));
        }),
        route("POST", "/token", (r) => {
          seen.push(r.url.href);
          return json(fixture("token"));
        }),
        (r) =>
          r.method === "GET" && r.url.pathname === "/iceberg/v1/config"
            ? json(fixture("config-s3tables"))
            : undefined,
        route(
          "GET",
          "/iceberg/v1/arn%3Aaws%3As3tables%3Aus-east-1%3A000000000000%3Abucket%2Ferrtraq/namespaces/errtraq/tables/events",
          () => json(fixture("load-table")),
        ),
      ]);
      let now = 0;
      const { tokenEndpoint: _unused, ...withoutEndpoint } = authConfig;
      // The first request cannot know the discovered endpoint, so it uses the spec default.
      const catalog = new IcebergRestCatalog({
        uri: "https://auth.example.test/iceberg",
        auth: withoutEndpoint,
        fetch,
        now: () => now,
      });
      await catalog.getConfig();
      expect(seen).toEqual([
        "https://auth.example.test/iceberg/v1/oauth/tokens",
      ]);
      now += 3_600_000; // the 300 s token from the fixture has expired
      await catalog.loadTable(["errtraq"], "events");
      expect(seen[1]).toBe("https://auth.example.test/token");
    });

    it("raises an auth error without echoing the token endpoint response", async () => {
      const { fetch } = fakeFetch([
        route("POST", "/token", () =>
          json(
            JSON.stringify({ error: "invalid_client", hint: "secret-hint" }),
            401,
          ),
        ),
      ]);
      const error = await new IcebergRestCatalog({
        uri: BASE,
        auth: authConfig,
        fetch,
      })
        .getConfig()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CatalogAuthError);
      expect(JSON.stringify(error)).not.toContain("secret-hint");
      expect((error as Error).message).not.toContain("secret-hint");
    });
  });

  describe("sigv4", () => {
    const credentials = async () => ({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      sessionToken: "session-token",
    });

    it("signs each request with the s3tables signing name", async () => {
      const { fetch, requests } = fakeFetch([
        route("GET", "/iceberg/v1/config", () =>
          json(fixture("config-s3tables")),
        ),
      ]);
      await new IcebergRestCatalog({
        uri: "https://s3tables.us-east-1.example.test/iceberg",
        warehouse: "arn:aws:s3tables:us-east-1:000000000000:bucket/errtraq",
        auth: { type: "sigv4", region: "us-east-1", credentials },
        fetch,
      }).getConfig();
      const authorization = requests[0]?.headers.get("authorization") ?? "";
      expect(authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3tables\/aws4_request/,
      );
      expect(requests[0]?.headers.get("x-amz-security-token")).toBe(
        "session-token",
      );
      expect(requests[0]?.headers.has("x-amz-date")).toBe(true);
      expect(requests[0]?.url.searchParams.get("warehouse")).toBe(
        "arn:aws:s3tables:us-east-1:000000000000:bucket/errtraq",
      );
    });

    it("signs POST bodies and honours a custom signing name", async () => {
      const { fetch, requests } = fakeFetch([
        route("GET", "/v1/config", () =>
          json(JSON.stringify({ defaults: { prefix: "p" }, overrides: {} })),
        ),
        route("POST", "/v1/p/namespaces", () => json("{}")),
      ]);
      const catalog = new IcebergRestCatalog({
        uri: "https://glue.us-east-1.example.test",
        auth: {
          type: "sigv4",
          region: "us-east-1",
          credentials,
          signingName: "glue",
        },
        fetch,
      });
      await catalog.createNamespace(["errtraq"]);
      expect(requests[1]?.headers.get("authorization")).toContain(
        "/us-east-1/glue/aws4_request",
      );
      expect(
        requests[1]?.headers.get("x-amz-content-sha256") ?? "x",
      ).toBeTruthy();
    });
  });
});
