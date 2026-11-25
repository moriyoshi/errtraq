import { describe, expect, it } from "vitest";
import { postgresPoolConfig } from "./postgres-dialect.js";

describe("postgres pool config", () => {
  it("bounds statements on the server for a direct connection", () => {
    const config = postgresPoolConfig("postgres://db.example/errtraq", 1234);
    expect(config.statement_timeout).toBe(1234);
    expect(config.idle_in_transaction_session_timeout).toBe(35000);
    expect(config.query_timeout).toBeUndefined();
  });
  it("sends no session timeouts as startup options through RDS Proxy", () => {
    // The proxy refuses them ("RDS Proxy currently doesn't support the option
    // statement_timeout", run 3); the bound moves to pg's client-side query_timeout.
    const config = postgresPoolConfig({ host: "proxy.example" }, 1234, {
      viaProxy: true,
    });
    expect(config.statement_timeout).toBeUndefined();
    expect(config.idle_in_transaction_session_timeout).toBeUndefined();
    expect(config.query_timeout).toBe(1234);
    expect(config.host).toBe("proxy.example");
  });
});
