import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapCommand, runBootstrap } from "./bootstrap.mjs";
import { PROJECT, REGION } from "./testing.mjs";

describe("bootstrap helper", () => {
  it("builds the remote bootstrap command from the outputs", () => {
    const args = bootstrapCommand({
      stackFile: "s.ts",
      outputs: { bootstrap_url: "https://b", ingest_url: "https://i" },
      config: { org: "default", projectSlug: "default" },
    });
    expect(args.slice(1, 4)).toEqual(["bootstrap", "--remote", "--stack"]);
    expect(args).toContain("https://b");
    expect(() =>
      bootstrapCommand({ stackFile: "s", outputs: {}, config: {} }),
    ).toThrow("bootstrap_url");
  });
  it("passes the token only through the child environment and scrubs the output", async () => {
    mkdirSync(resolve(".agents-workspace/tmp"), { recursive: true });
    const dir = mkdtempSync(join(resolve(".agents-workspace/tmp"), "g8-"));
    const outputs = join(dir, "o.json");
    writeFileSync(
      outputs,
      JSON.stringify({
        bootstrap_url: { value: "https://b.run.app" },
        ingest_url: { value: "https://i.run.app" },
      }),
    );
    let childEnv;
    const spawnProcess = (_node, _args, options) => {
      childEnv = options.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          `Bootstrap complete in ${PROJECT} via https://b.run.app with SECRET-TOKEN\n`,
        );
        child.emit("close", 0);
      });
      return child;
    };
    const lines = [];
    const code = await runBootstrap({
      argv: [
        "--project",
        PROJECT,
        "--region",
        REGION,
        "--outputs",
        outputs,
        "--stack-file",
        "stack.ts",
      ],
      env: {},
      spawnProcess,
      auth: {
        idToken: async (audience) =>
          audience === "errtraq-push" ? "SECRET-TOKEN" : "wrong",
      },
      print: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(childEnv.ERRTRAQ_GCP_ID_TOKEN).toBe("SECRET-TOKEN");
    expect(lines.join("\n")).not.toMatch(/SECRET-TOKEN|b\.run\.app/);
    expect(lines.join("\n")).not.toContain(PROJECT);
  });
});
