#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  physicalFunctions,
  resolveStack,
  selections,
  stackOrigin,
} from "@errtraq/core";
import { buildSummary, dsnHost, dsnOrigin } from "./address.js";
import { buildStack } from "./build.js";
import { constructStack } from "./construction.js";
import { bootstrapAwsStack } from "./deployed-bootstrap.js";
import {
  formatTokens,
  listTokens,
  revokeToken,
  withDeployedStore,
} from "./deployed-token.js";
import { generateInfra, projectRoot, safeDirectory } from "./infra.js";
import { assertNodeVersion } from "./node-version.js";
import { devToken } from "./token.js";
import { formatValidation } from "./validation.js";

interface DevPlatform {
  prepare(
    rotate: boolean,
    tokenManager: typeof devToken,
  ): Promise<{ token: string; publicKey: string; projectId: string }>;
  start(): Promise<{
    host: string;
    port: number;
    publicUrl?: string;
    close(): Promise<void>;
  }>;
}
function isDevPlatform(value: unknown): value is DevPlatform {
  return (
    !!value &&
    typeof value === "object" &&
    "prepare" in value &&
    typeof value.prepare === "function" &&
    "start" in value &&
    typeof value.start === "function"
  );
}
let scrubRoot: string | undefined;
export async function main(args: string[]): Promise<void> {
  assertNodeVersion(process.versions.node);
  const [command, ...initial] = args;
  const rotate = command === "token" && initial[0] === "rotate";
  const infra = command === "infra" && initial[0] === "generate";
  const tokenAdmin =
    command === "token" && (initial[0] === "list" || initial[0] === "revoke")
      ? initial[0]
      : undefined;
  const rest = rotate || infra || tokenAdmin ? initial.slice(1) : initial;
  if (
    !rotate &&
    !infra &&
    !tokenAdmin &&
    !["dev", "validate", "build", "bootstrap"].includes(command ?? "")
  )
    throw new Error(
      "Usage: errtraq <dev|validate|build|bootstrap|infra generate|token rotate|token list|token revoke> --stack <file> [--out dir]",
    );
  const options: Record<string, string> = {};
  let allowMissing = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--force" && tokenAdmin === "revoke") {
      options[flag] = "true";
      continue;
    }
    if (flag === "--allow-missing-artifacts" && infra) {
      allowMissing = true;
      continue;
    }
    if (
      !flag ||
      ![
        "--stack",
        "--out",
        "--build-dir",
        ...(command === "build" || infra ? ["--root"] : []),
        ...(infra ? ["--module-source", "--module-base"] : []),
        ...(command === "bootstrap"
          ? ["--secret-name", "--ingest-url", "--org", "--project"]
          : tokenAdmin
            ? ["--org", ...(tokenAdmin === "revoke" ? ["--id"] : [])]
            : []),
      ].includes(flag) ||
      !rest[i + 1] ||
      options[flag]
    )
      throw new Error("Invalid command arguments");
    options[flag] = rest[++i] ?? "";
  }
  if (
    !options["--stack"] ||
    (options["--out"] && !(infra || command === "build")) ||
    (options["--build-dir"] && !infra)
  )
    throw new Error("Invalid command arguments: --stack is required");
  const moduleSource = options["--module-source"];
  if (
    moduleSource !== undefined &&
    !["relative", "vendor", "remote"].includes(moduleSource)
  )
    throw new Error("--module-source must be relative, vendor or remote");
  const file = await realpath(resolve(options["--stack"])).catch(() =>
    resolve(options["--stack"] ?? ""),
  );
  const imported: unknown = await import(pathToFileURL(file).href);
  if (!imported || typeof imported !== "object" || !("default" in imported))
    throw new Error("Stack must export a default configuration");
  if (stackOrigin(imported.default) === "other-core")
    throw new Error(
      "The stack file loads a different copy of @errtraq/core than the errtraq CLI; install one shared @errtraq/core (it is a peer dependency of every errtraq package) and avoid duplicate copies in node_modules",
    );
  const stack = resolveStack(imported.default);
  if (tokenAdmin) {
    const orgSlug = options["--org"];
    if (!orgSlug || (tokenAdmin === "revoke" && !options["--id"]))
      throw new Error(
        tokenAdmin === "list"
          ? "token list requires --org"
          : "token revoke requires --org and --id",
      );
    await withDeployedStore(stack, process.env, async (store) => {
      if (tokenAdmin === "list")
        console.log(formatTokens(await listTokens(store, orgSlug)));
      else {
        const revoked = await revokeToken(store, {
          orgSlug,
          id: options["--id"] ?? "",
          force: options["--force"] === "true",
        });
        console.log(`Revoked token ${revoked.id} at ${revoked.revokedAt}`);
      }
    });
    return;
  }
  if (command === "bootstrap") {
    if (
      !options["--secret-name"] ||
      !options["--ingest-url"] ||
      !options["--org"] ||
      !options["--project"]
    )
      throw new Error(
        "Bootstrap requires --secret-name, --ingest-url, --org and --project",
      );
    const arn = await bootstrapAwsStack(stack, process.env, {
      secretName: options["--secret-name"],
      ingestUrl: options["--ingest-url"],
      orgSlug: options["--org"],
      projectSlug: options["--project"],
    });
    console.log(
      `Bootstrap complete; read DSN and API token from Secrets Manager: ${arn}`,
    );
    return;
  }
  if (command === "validate") {
    console.log(formatValidation(stack));
    return;
  }
  if (command === "build" || infra) {
    const repo = await projectRoot(file, { root: options["--root"] });
    scrubRoot = repo;
    const defaultBuild = resolve(repo, "dist", stack.name);
    if (command === "build") {
      const directory = await safeDirectory(
        repo,
        resolve(options["--out"] ?? defaultBuild),
      );
      const manifest = await buildStack(stack, repo, directory, file);
      console.log(
        buildSummary(
          stack.name,
          relative(repo, directory),
          manifest.platform,
          Object.keys(manifest.artifacts).length,
        ),
      );
    } else
      console.log(
        await generateInfra(
          stack,
          repo,
          resolve(
            options["--out"] ?? resolve(repo, "infra/generated", stack.name),
          ),
          resolve(options["--build-dir"] ?? defaultBuild),
          allowMissing,
          {
            moduleSource: moduleSource as "relative" | "vendor" | "remote",
            moduleBase: options["--module-base"],
          },
        ),
      );
    return;
  }
  const platformSelection = [...selections(stack)].find(
    ([path, selection]) =>
      !path.includes(".") && selection.manifest.kind === "platform",
  )?.[1];
  if (!platformSelection) throw new Error("Missing platform adapter");
  const functions = physicalFunctions(platformSelection.config);
  if (functions.length !== 1)
    throw new Error("The dev command requires one physical function");
  const created = await constructStack(
    stack,
    functions[0]?.roles ?? [],
    process.env,
  );
  let failed = false;
  try {
    if (!isDevPlatform(created.platform))
      throw new Error("Platform does not support local development");
    const platform = created.platform;
    const project = await platform.prepare(rotate, devToken);
    const token = project.token;
    if (rotate) {
      console.log(`API token: ${token}`);
      return;
    }
    const server = await platform.start();
    const urlHost = dsnHost(server.host);
    const destination = dsnOrigin(server.host, server.port, server.publicUrl);
    if (destination.fallback)
      console.log(
        "Note: DSN uses localhost; use your public host for remote clients.",
      );
    const dsn = new URL(destination.origin);
    dsn.username = project.publicKey;
    dsn.pathname = `/${project.projectId}`;
    console.log(`DSN: ${dsn.toString()}`);
    console.log(`API token: ${token}`);
    console.log(`Listening: http://${urlHost}:${server.port}`);
    await new Promise<void>((done) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        void server.close().then(done, (error) => {
          console.error(String(error));
          process.exitCode = 1;
          done();
        });
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } catch (error) {
    failed = true;
    try {
      await created.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Operation and cleanup failed",
      );
    }
    throw error;
  } finally {
    if (!failed) await created.close();
  }
}
function stackArgument(): string | undefined {
  const index = process.argv.indexOf("--stack");
  return index >= 0 ? process.argv[index + 1] : undefined;
}
main(process.argv.slice(2)).catch(async (error) => {
  const stackFile = stackArgument();
  const repo =
    scrubRoot ??
    (stackFile
      ? await projectRoot(stackFile).catch(() => undefined)
      : undefined);
  let message = error instanceof Error ? error.message : String(error);
  if (repo)
    message = message.replaceAll(`${repo}${sep}`, "").replaceAll(repo, ".");
  const home = homedir();
  if (home.length > 1) message = message.replaceAll(home, "~");
  console.error(message);
  process.exitCode = 1;
});
