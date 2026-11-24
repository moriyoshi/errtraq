import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureIamUser,
  PostgresProvisionError,
  parseAdminSecret,
  privilegeStatements,
  provisionIamUser,
  quoteIdentifier,
} from "./postgres-admin.js";

function client(exists: boolean, failCreate?: { code: string }) {
  const statements: { text: string; values?: unknown[] }[] = [];
  return {
    statements,
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      if (text.startsWith("select 1 from pg_roles"))
        return { rows: exists ? [{}] : [] };
      if (text.startsWith("create role") && failCreate)
        throw Object.assign(new Error("duplicate"), failCreate);
      return { rows: [] };
    },
  };
}

describe("Postgres IAM user provisioning", () => {
  it("quotes identifiers by doubling quotes", () => {
    expect(quoteIdentifier("app_user")).toBe('"app_user"');
    expect(quoteIdentifier('a"; drop table x; --')).toBe(
      '"a""; drop table x; --"',
    );
    expect(() => quoteIdentifier("")).toThrow();
    expect(() => quoteIdentifier("a\0b")).toThrow();
  });
  it("grants the IAM login, connect, schema and table privileges", () => {
    expect(privilegeStatements("app_user", "errtraq")).toEqual([
      'grant rds_iam to "app_user"',
      'grant connect on database "errtraq" to "app_user"',
      'grant usage, create on schema public to "app_user"',
      'grant all on all tables in schema public to "app_user"',
      'grant all on all sequences in schema public to "app_user"',
    ]);
  });
  it("creates a missing role once, binds the name as a value, and grants", async () => {
    const c = client(false);
    await ensureIamUser(c, "app_user", "errtraq");
    expect(c.statements[0]).toEqual({
      text: "select 1 from pg_roles where rolname = $1",
      values: ["app_user"],
    });
    expect(c.statements[1]?.text).toBe('create role "app_user" login');
    expect(c.statements.slice(2).map((s) => s.text)).toEqual(
      privilegeStatements("app_user", "errtraq"),
    );
  });
  it("is idempotent: an existing role is not recreated, a lost race is tolerated", async () => {
    const existing = client(true);
    await ensureIamUser(existing, "app_user", "errtraq");
    expect(existing.statements.some((s) => s.text.startsWith("create"))).toBe(
      false,
    );
    const raced = client(false, { code: "42710" });
    await ensureIamUser(raced, "app_user", "errtraq");
    expect(raced.statements.at(-1)?.text).toContain("sequences");
    await expect(
      ensureIamUser(client(false, { code: "42501" }), "app_user", "errtraq"),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("never interpolates a hostile user name as SQL", async () => {
    const c = client(false);
    await ensureIamUser(c, 'x" login superuser; --', "db");
    for (const { text } of c.statements.slice(1))
      expect(text).toContain('"x"" login superuser; --"');
  });
  it("parses the RDS-managed secret and rejects anything else without echoing it", () => {
    expect(parseAdminSecret('{"username":"postgres","password":"pw"}')).toEqual(
      { username: "postgres", password: "pw" },
    );
    for (const bad of ["not json", "[]", '{"username":"x"}', '{"password":1}'])
      expect(() => parseAdminSecret(bad)).toThrow(
        "Invalid PostgreSQL administrator secret",
      );
  });
  it("connects over verified TLS as the administrator and always disconnects", async () => {
    const c = client(false);
    const end = vi.fn(async () => {});
    let seen: unknown;
    await provisionIamUser({
      host: "db.example.rds.amazonaws.com",
      port: 5432,
      database: "errtraq",
      user: "app_user",
      ca: "-----BEGIN CERTIFICATE-----",
      admin: { username: "postgres", password: "pw" },
      connect: async (config) => {
        seen = config;
        return Object.assign(c, { end });
      },
    });
    expect(seen).toMatchObject({
      host: "db.example.rds.amazonaws.com",
      user: "postgres",
      password: "pw",
      database: "errtraq",
      ssl: {
        rejectUnauthorized: true,
        servername: "db.example.rds.amazonaws.com",
      },
    });
    expect(end).toHaveBeenCalledOnce();
  });
  it("reports failures by fixed message and code only", async () => {
    const end = vi.fn(async () => {});
    const failing = {
      async query() {
        throw Object.assign(
          new Error(
            'password authentication failed for user "postgres" pw=hunter2',
          ),
          { code: "28P01" },
        );
      },
      end,
    };
    const error = await provisionIamUser({
      host: "db.example.rds.amazonaws.com",
      port: 5432,
      database: "errtraq",
      user: "app_user",
      ca: "ca",
      admin: { username: "postgres", password: "hunter2" },
      connect: async () => failing,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PostgresProvisionError);
    expect(error).toMatchObject({ code: "28P01" });
    expect(String((error as Error).message)).not.toContain("hunter2");
    expect(JSON.stringify(error)).not.toContain("hunter2");
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("Postgres adapter administrator wiring", () => {
  let directory: string | undefined;
  afterEach(async () => {
    vi.doUnmock("./postgres-admin.js");
    vi.resetModules();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });
  async function context(withAdmin: boolean) {
    directory = await mkdtemp(join(tmpdir(), "errtraq-pg-ca-"));
    const path = join(directory, "ca.pem");
    await writeFile(
      path,
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
    );
    return {
      config: { mode: "iam" },
      bindings: {
        ERRTRAQ_POSTGRES_HOST: "127.0.0.1",
        ERRTRAQ_POSTGRES_PORT: "1",
        ERRTRAQ_POSTGRES_DATABASE: "errtraq",
        ERRTRAQ_POSTGRES_USER: "app_user",
        ERRTRAQ_POSTGRES_REGION: "us-east-1",
        ERRTRAQ_POSTGRES_CA_PATH: path,
        ...(withAdmin ? { ERRTRAQ_POSTGRES_ADMIN_SECRET: "arn:admin" } : {}),
      },
      dependencies: {},
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "key" },
      secretSource: {
        read: async () => '{"username":"postgres","password":"pw"}',
      },
    };
  }
  it("provisions the user before migrating only when the admin secret was delivered", async () => {
    const calls: unknown[] = [];
    vi.resetModules();
    vi.doMock("./postgres-admin.js", async (original) => ({
      ...(await original<typeof import("./postgres-admin.js")>()),
      provisionIamUser: async (options: unknown) => {
        calls.push(options);
      },
    }));
    const { create } = await import("./postgres.js");
    const withAdmin = await create(await context(true));
    // Nothing listens on port 1, so the migration itself fails after provisioning.
    await expect(withAdmin.migrate()).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: "127.0.0.1",
      user: "app_user",
      database: "errtraq",
      admin: { username: "postgres", password: "pw" },
    });
    await withAdmin.close();
    const runtime = await create(await context(false));
    await expect(runtime.migrate()).rejects.toThrow();
    expect(calls).toHaveLength(1);
    await runtime.close();
  });
});
