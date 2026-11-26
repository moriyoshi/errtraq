import { fileURLToPath } from "node:url";
import { probe as deploy } from "./deploy.mjs";
import { probe as firestore } from "./firestore.mjs";
import { probe as gcs } from "./gcs.mjs";
import { probe as iam } from "./iam.mjs";
import { probe as inventory } from "./inventory.mjs";
import { main, parseFlags } from "./lib.mjs";
import { probe as push } from "./push.mjs";
import { probe as cron } from "./scheduler-cron.mjs";
import { probe as sdk } from "./sdk-e2e.mjs";

/**
 * Runs the selected G8 probes in order. `--probes sdk,push,...` selects (default: every probe but
 * `inventory`, which is the post-destroy check and is selected explicitly). All values come from
 * flags and the environment; see .agents-docs/G8_RUN1_PLAN.md.
 */
export const ALL = { deploy, sdk, push, firestore, gcs, cron, iam, inventory };
export const DEFAULT_ORDER = [
  "deploy",
  "sdk",
  "push",
  "firestore",
  "gcs",
  "cron",
  "iam",
];

export function selectProbes(flags) {
  const names =
    typeof flags.probes === "string"
      ? flags.probes.split(",").filter(Boolean)
      : DEFAULT_ORDER;
  const unknown = names.filter((name) => !ALL[name]);
  if (unknown.length)
    throw new Error(
      `Unknown probe: ${unknown.join(", ")} (known: ${Object.keys(ALL).join(", ")})`,
    );
  return names.map((name) => ALL[name]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { flags } = parseFlags(process.argv.slice(2));
  process.exit(await main(selectProbes(flags)));
}
