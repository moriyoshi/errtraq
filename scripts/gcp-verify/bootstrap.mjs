import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createAuth,
  createScrubber,
  loadConfig,
  loadOutputs,
  parseFlags,
} from "./lib.mjs";

/**
 * Runs `errtraq bootstrap --remote` against the deployed bootstrap service. The ID token (audience
 * = the stack's OIDC audience) is minted in memory, by impersonating the operator service account
 * named in `ERRTRAQ_GCP_IMPERSONATE_SA` or taken from `ERRTRAQ_GCP_ID_TOKEN`, and handed to the
 * child process through its environment only. The CLI's own output (ids, never the DSN or token)
 * is passed through scrubbed.
 */
export function bootstrapCommand({ stackFile, outputs, config }) {
  if (!outputs.bootstrap_url || !outputs.ingest_url)
    throw new Error("The Terraform outputs need bootstrap_url and ingest_url");
  return [
    "packages/cli/dist/bin.js",
    "bootstrap",
    "--remote",
    "--stack",
    stackFile,
    "--service-url",
    outputs.bootstrap_url,
    "--ingest-url",
    outputs.ingest_url,
    "--org",
    config.org,
    "--project",
    config.projectSlug,
  ];
}

export async function runBootstrap({
  argv,
  env,
  spawnProcess = spawn,
  auth,
  print = console.log,
}) {
  const { flags } = parseFlags(argv);
  const config = loadConfig(flags, env);
  const stackFile = flags["stack-file"];
  if (typeof stackFile !== "string")
    throw new Error("Pass --stack-file <the derived run stack>");
  const outputs = await loadOutputs(config.outputsPath);
  const { scrub } = createScrubber(config);
  const token = await (auth ?? createAuth({ env })).idToken(config.audience);
  const child = spawnProcess(
    process.execPath,
    bootstrapCommand({ stackFile, outputs, config }),
    {
      env: { ...env, ERRTRAQ_GCP_ID_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => (output += String(chunk)));
  const code = await new Promise((done) => child.on("close", done));
  for (const line of output.split("\n").filter(Boolean))
    print(scrub(line.split(token).join("<token>")));
  return code ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(
    await runBootstrap({ argv: process.argv.slice(2), env: process.env }),
  );
