import { validateStack, variable } from "@moriyoshi/errtraq-core";
import { describe, expect, it, vi } from "vitest";
import { create } from "./postgres.js";
import {
  ensureIamUser,
  ensureIamUsers,
  memberPrivilegeStatements,
  memberTableStatements,
  privilegeStatements,
} from "./postgres-admin.js";
import {
  CloudSqlTokenError,
  cloudSqlIamPoolConfig,
  cloudSqlIamUserName,
  cloudSqlTransport,
  parseGrantUsers,
} from "./postgres-cloudsql.js";
import { postgres } from "./postgres-stack.js";

const ICN = "project:region:instance";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
const SA = "app-store@project.iam.gserviceaccount.com";

describe("Cloud SQL IAM user name", () => {
  it("drops the .gserviceaccount.com suffix and nothing else", () => {
    expect(cloudSqlIamUserName(SA)).toBe("app-store@project.iam");
  });
  it("rejects anything that is not a service account email", () => {
    for (const bad of [
      "person@example.com",
      "app@project.iam",
      "",
      "x@y.gserviceaccount.com.evil.test",
    ])
      expect(() => cloudSqlIamUserName(bad)).toThrow();
  });
});

describe("Cloud SQL pool configuration", () => {
  const accessToken = async () => "tok";
  it("uses the mounted unix socket without TLS by default", () => {
    const config = cloudSqlIamPoolConfig({
      instanceConnectionName: ICN,
      database: "db",
      user: "u",
      accessToken,
      connection: { kind: "unix-socket" },
    });
    // pg appends /.s.PGSQL.5432 to a directory host.
    expect(config).toMatchObject({
      host: `/cloudsql/${ICN}`,
      port: 5432,
      ssl: false,
      database: "db",
      user: "u",
    });
  });
  it("honours another socket directory and refuses over-long socket paths", () => {
    expect(
      cloudSqlTransport({
        instanceConnectionName: ICN,
        connection: { kind: "unix-socket", socketDir: "/run/sql/" },
      }).host,
    ).toBe(`/run/sql/${ICN}`);
    expect(() =>
      cloudSqlTransport({
        instanceConnectionName: `${"p".repeat(40)}:${"r".repeat(30)}:${"i".repeat(40)}`,
        connection: { kind: "unix-socket" },
      }),
    ).toThrow("108");
  });
  it("pins the server CA over TCP and skips only the hostname check without a server name", () => {
    const perInstance = cloudSqlIamPoolConfig({
      instanceConnectionName: ICN,
      database: "db",
      user: "u",
      accessToken,
      connection: { kind: "tcp", host: "10.0.0.5", serverCa: CA },
    });
    expect(perInstance).toMatchObject({ host: "10.0.0.5", port: 5432 });
    const ssl = perInstance.ssl as {
      ca: string;
      rejectUnauthorized: boolean;
      checkServerIdentity: () => unknown;
      servername?: string;
    };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe(CA);
    expect(ssl.checkServerIdentity()).toBeUndefined();
    expect(ssl.servername).toBeUndefined();
    const named = cloudSqlIamPoolConfig({
      instanceConnectionName: ICN,
      database: "db",
      user: "u",
      accessToken,
      connection: {
        kind: "tcp",
        host: "10.0.0.5",
        port: 6543,
        serverCa: CA,
        serverName: "uid.label.region.sql-psa.goog",
      },
    });
    expect(named.port).toBe(6543);
    expect(named.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: "uid.label.region.sql-psa.goog",
    });
    expect(named.ssl).not.toHaveProperty("checkServerIdentity");
  });
  it("refuses a missing CA instead of disabling verification", () => {
    expect(() =>
      cloudSqlTransport({
        instanceConnectionName: ICN,
        connection: { kind: "tcp", host: "10.0.0.5", serverCa: "" },
      }),
    ).toThrow("Invalid Cloud SQL server CA");
  });
  it("asks for a fresh token on every call and hides token errors", async () => {
    let n = 0;
    const config = cloudSqlIamPoolConfig({
      instanceConnectionName: ICN,
      database: "db",
      user: "u",
      accessToken: async () => `token-${++n}`,
      connection: { kind: "unix-socket" },
    });
    const password = config.password;
    if (typeof password !== "function") throw new Error("callback expected");
    expect(await password()).toBe("token-1");
    expect(await password()).toBe("token-2");
    for (const failing of [
      async () => {
        throw new Error("secret detail ya29.leak");
      },
      async () => "",
    ]) {
      const bad = cloudSqlIamPoolConfig({
        instanceConnectionName: ICN,
        database: "db",
        user: "u",
        accessToken: failing,
        connection: { kind: "unix-socket" },
      }).password;
      if (typeof bad !== "function") throw new Error("callback expected");
      const error = await Promise.resolve(bad()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudSqlTokenError);
      expect(String((error as Error).message)).not.toContain("leak");
    }
  });
});

describe("Cloud SQL stack selection", () => {
  const base = {
    mode: "cloudsql-iam" as const,
    instanceConnectionName: ICN,
    region: "europe-west1",
    database: "errtraq",
  };
  const binding = (s: ReturnType<typeof postgres>, name: string) =>
    s.infra.bindings.find((item) => item.name === name)?.value;
  it("leaves the user to each runtime identity, defaults to the socket and names the module", () => {
    const s = postgres(base);
    expect(binding(s, "ERRTRAQ_POSTGRES_USER")).toBeUndefined();
    // No shared database_user: the platform module creates one IAM user per function account.
    expect(s.infra.inputs(s.config as never, {} as never)).not.toHaveProperty(
      "database_user",
    );
    expect(binding(s, "ERRTRAQ_POSTGRES_SOCKET_DIR")).toBe("/cloudsql");
    expect(binding(s, "ERRTRAQ_POSTGRES_HOST")).toBeUndefined();
    expect(s.infra.module).toMatchObject({
      provider: "google",
      component: "cloudsql-iam-access",
    });
    expect(s.infra.capabilities["project-read"]).toEqual(
      s.infra.capabilities.read,
    );
    expect(s.config).toEqual({
      mode: "cloudsql-iam",
      instanceConnectionName: ICN,
      region: "europe-west1",
      database: "errtraq",
    });
    expect(s.manifest.requires).toEqual(["ambient-credentials"]);
  });
  it("carries the TCP form and the admin secret to the bootstrap role only", () => {
    const s = postgres({
      ...base,
      connection: {
        kind: "tcp",
        host: "10.0.0.5",
        serverCa: variable("server_ca"),
        serverName: "uid.label.region.sql-psa.goog",
      },
      adminSecret: variable("admin"),
    });
    expect(binding(s, "ERRTRAQ_POSTGRES_HOST")).toBe("10.0.0.5");
    expect(binding(s, "ERRTRAQ_POSTGRES_PORT")).toBe("5432");
    expect(binding(s, "ERRTRAQ_POSTGRES_SERVER_CA")).toEqual(
      variable("server_ca"),
    );
    expect(binding(s, "ERRTRAQ_POSTGRES_SERVER_NAME")).toBe(
      "uid.label.region.sql-psa.goog",
    );
    const admin = s.infra.bindings.find(
      (item) => item.name === "ERRTRAQ_POSTGRES_ADMIN_SECRET",
    );
    expect(admin).toMatchObject({ kind: "secret", capabilities: ["admin"] });
    expect(s.infra.capabilities.admin).toEqual({ primary: null });
  });
  it("rejects a shared serviceAccountEmail: it contradicts one IAM database user per function", () => {
    expect(() =>
      postgres({ ...base, serviceAccountEmail: SA } as never),
    ).toThrow(/serviceAccountEmail is not supported/);
  });
  it("rejects bad configuration", () => {
    for (const bad of [
      { ...base, instanceConnectionName: "nope" },
      { ...base, region: "" },
      { ...base, secret: variable("s") },
      { ...base, connection: { kind: "tcp", host: "10.0.0.5" } },
      { ...base, connection: { kind: "unix-socket", socketDir: "/a/../b" } },
      { ...base, connection: { kind: "unix-socket", socketDir: "rel" } },
    ])
      expect(() => postgres(bad as never)).toThrow();
  });
  it("validates against a stack once a provider of the module family exists", async () => {
    // The module family `google` matches the real `hashicorp/google` provider source.
    const { default: aws } = await import("../../../../stacks/aws-dynamodb.js");
    const store = postgres(base);
    const stack = (providers: object, selection = store) =>
      ({
        ...Object.fromEntries(Object.entries(aws)),
        store: selection,
        platform: {
          ...aws.platform,
          manifest: {
            ...aws.platform.manifest,
            provides: [
              ...aws.platform.manifest.provides,
              "ambient-credentials",
            ],
          },
        },
        providers,
      }) as never;
    expect(
      validateStack(stack(aws.providers ?? {})).map((i) => i.message),
    ).toContain("Missing provider requirement");
    const providers = {
      ...aws.providers,
      google: {
        source: "hashicorp/google",
        version: "~> 8.0",
        region: "europe-west1",
        project: "example-project",
      },
    };
    expect(validateStack(stack(providers))).toEqual([]);
    const doc = '{"Version":"2012-10-17","Statement":[]}';
    const existing = {
      ...store,
      existing: {
        policies: {
          read: { primary: doc },
          write: { primary: doc },
          delete: { primary: doc },
        },
      },
    };
    expect(validateStack(stack(providers, existing))).toEqual([]);
  });
});

describe("Cloud SQL runtime construction", () => {
  const bindings = {
    ERRTRAQ_POSTGRES_INSTANCE: ICN,
    ERRTRAQ_POSTGRES_DATABASE: "db",
    ERRTRAQ_POSTGRES_USER: "u@p.iam",
    accessToken: async () => "tok",
  };
  it("builds a store on the socket without connecting", async () => {
    const store = await create({
      config: { mode: "cloudsql-iam" },
      bindings,
      dependencies: {},
    });
    await store.close();
  });
  it("derives the user from the runtime identity when no binding names it", async () => {
    const { ERRTRAQ_POSTGRES_USER: _, ...rest } = bindings;
    const store = await create({
      config: { mode: "cloudsql-iam" },
      bindings: { ...rest, serviceAccountEmail: async () => SA },
      dependencies: {},
    });
    await store.close();
    await expect(
      create({
        config: { mode: "cloudsql-iam" },
        bindings: rest,
        dependencies: {},
      }),
    ).rejects.toThrow("ERRTRAQ_POSTGRES_USER");
  });
  it("fails clearly without a token source or required bindings", async () => {
    const { accessToken: _, ...noToken } = bindings;
    await expect(
      create({
        config: { mode: "cloudsql-iam" },
        bindings: noToken,
        dependencies: {},
      }),
    ).rejects.toThrow("access token source");
    await expect(
      create({
        config: { mode: "cloudsql-iam" },
        bindings: { ...bindings, ERRTRAQ_POSTGRES_INSTANCE: undefined },
        dependencies: {},
      }),
    ).rejects.toThrow("ERRTRAQ_POSTGRES_INSTANCE");
    await expect(
      create({
        config: { mode: "cloudsql-iam" },
        bindings: { ...bindings, ERRTRAQ_POSTGRES_HOST: "10.0.0.5" },
        dependencies: {},
      }),
    ).rejects.toThrow("ERRTRAQ_POSTGRES_SERVER_CA");
  });
  it("needs a secret source for administration", async () => {
    await expect(
      create({
        config: { mode: "cloudsql-iam" },
        bindings: { ...bindings, ERRTRAQ_POSTGRES_ADMIN_SECRET: "x" },
        dependencies: {},
      }),
    ).rejects.toThrow("secret source");
  });
});

describe("Cloud SQL administration", () => {
  it("does not grant rds_iam and requires the Terraform-created user", async () => {
    expect(privilegeStatements("u@p.iam", "db", "cloudsql")).not.toContainEqual(
      expect.stringContaining("rds_iam"),
    );
    expect(privilegeStatements("u", "db")[0]).toContain("rds_iam");
    const statements: string[] = [];
    const client = (exists: boolean) => ({
      query: async (text: string) => {
        statements.push(text);
        return { rows: exists ? [{}] : [] };
      },
    });
    await expect(
      ensureIamUser(client(false), "u@p.iam", "db", "cloudsql"),
    ).rejects.toMatchObject({ code: "ROLE_MISSING" });
    expect(statements.some((s) => s.startsWith("create role"))).toBe(false);
    await ensureIamUser(client(true), "u@p.iam", "db", "cloudsql");
    expect(statements.some((s) => s.startsWith("create role"))).toBe(false);
    expect(statements.some((s) => s.includes('"u@p.iam"'))).toBe(true);
  });
});

describe("Cloud SQL grants for every function user", () => {
  const recorder = (existing: string[]) => {
    const statements: string[] = [];
    return {
      statements,
      query: async (text: string, values?: unknown[]) => {
        statements.push(text);
        return {
          rows:
            text.startsWith("select 1") &&
            existing.includes(String(values?.[0]))
              ? [{}]
              : [],
        };
      },
    };
  };
  const a = "api@p.iam";
  const b = "consumer@p.iam";
  const c = "cron@p.iam";
  it("grants the migrating user ownership rights and the others connection-level access", async () => {
    const client = recorder([a, b, c]);
    await ensureIamUsers(client, a, [a, b, c, b], "db", "cloudsql");
    const text = client.statements.join("\n");
    // The migrator keeps create on the schema; the members only use it.
    expect(text).toContain(
      'grant usage, create on schema public to "api@p.iam"',
    );
    for (const user of [b, c]) {
      expect(text).toContain(`grant connect on database "db" to "${user}"`);
      expect(text).toContain(`grant usage on schema public to "${user}"`);
      expect(text).not.toContain(`create on schema public to "${user}"`);
    }
    // Duplicates and the migrator itself are granted once as a member.
    expect(
      client.statements.filter((s) =>
        s.includes(`connect on database "db" to "${b}"`),
      ),
    ).toHaveLength(1);
    expect(text).not.toContain("rds_iam");
  });
  it("fails clearly when Terraform did not create one of the users", async () => {
    await expect(
      ensureIamUsers(recorder([a]), a, [b], "db", "cloudsql"),
    ).rejects.toMatchObject({ code: "ROLE_MISSING" });
  });
  it("gives members data access only, now and for later migrations", () => {
    const statements = memberTableStatements([b]);
    expect(statements).toContain(
      'grant select, insert, update, delete on all tables in schema public to "consumer@p.iam"',
    );
    expect(
      statements.some((s) => s.startsWith("alter default privileges")),
    ).toBe(true);
    const all =
      statements.join("\n") + memberPrivilegeStatements(b, "db").join("\n");
    expect(all).not.toMatch(/grant all|truncate|create/);
    expect(memberTableStatements([])).toEqual([]);
  });
  it("quotes hostile user names", () => {
    expect(memberTableStatements(['x" to public; --'])[0]).toContain(
      '"x"" to public; --"',
    );
  });
});
describe("Cloud SQL grant user list", () => {
  it("parses, dedupes and validates the platform-supplied list", () => {
    expect(parseGrantUsers(undefined)).toEqual([]);
    expect(parseGrantUsers("a@p.iam, b@p.iam,a@p.iam")).toEqual([
      "a@p.iam",
      "b@p.iam",
    ]);
    for (const bad of [
      "a@p.iam,",
      'x"@p.iam',
      "a@p.example.com",
      "a b@p.iam",
      Array.from({ length: 33 }, (_, i) => `u${i}@p.iam`).join(","),
    ])
      expect(() => parseGrantUsers(bad)).toThrow(
        "Invalid Cloud SQL IAM user list",
      );
  });
  it("is read from the bootstrap role's binding and provisions every user", async () => {
    const seen: unknown[] = [];
    vi.doMock("./postgres-admin.js", async (original) => ({
      ...(await original<typeof import("./postgres-admin.js")>()),
      provisionIamUser: async (options: unknown) => {
        seen.push(options);
      },
    }));
    vi.resetModules();
    const { create: createMocked } = await import("./postgres.js");
    const store = await createMocked({
      config: { mode: "cloudsql-iam" },
      bindings: {
        ERRTRAQ_POSTGRES_INSTANCE: ICN,
        ERRTRAQ_POSTGRES_DATABASE: "db",
        ERRTRAQ_POSTGRES_USER: "boot@p.iam",
        ERRTRAQ_POSTGRES_GRANT_USERS: "boot@p.iam,api@p.iam,cron@p.iam",
        ERRTRAQ_POSTGRES_ADMIN_SECRET: "x",
        accessToken: async () => "tok",
      },
      dependencies: {},
      secretSource: {
        read: async () => JSON.stringify({ username: "a", password: "b" }),
      },
    });
    // The migration itself needs a server; only provisioning is observed here.
    await store.migrate().catch(() => undefined);
    await store.close();
    vi.doUnmock("./postgres-admin.js");
    expect(seen[0]).toMatchObject({
      user: "boot@p.iam",
      members: ["api@p.iam", "cron@p.iam"],
      flavor: "cloudsql",
    });
  });
});
