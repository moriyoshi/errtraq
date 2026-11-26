import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "./lib.mjs";

/**
 * Builds the Cloud Run image from `errtraq build` output (one Dockerfile and one bundle per
 * function) for linux/amd64 and prints the digest-pinned reference for `TF_VAR_CLOUD_RUN_IMAGE`.
 * The default is a dry run that prints the exact commands; `--execute` runs them.
 *
 * Docker is shared with other projects (Colima): only `errtraq-*` image names are built, and
 * nothing is pruned or restarted. Cloud Build is the alternative (`--builder cloud-build`); it
 * uploads the build directory to a staging bucket in the project, which the post-run inventory
 * lists as a leftover. The Dockerfile only COPYs the bundles, so no emulated amd64 step runs.
 */
const NAME = /^errtraq-[a-z0-9][a-z0-9._-]{0,60}$/;
const REPO = /^[a-z][a-z0-9-]{0,62}$/;
const DIGEST = /sha256:[a-f0-9]{64}/;

export function imageTag(
  buildDir,
  read = (path) => readFileSync(path, "utf8"),
) {
  const manifest = read(join(buildDir, "manifest.json"));
  return `g8-${createHash("sha256").update(manifest).digest("hex").slice(0, 12)}`;
}

export function planImage(options) {
  const {
    buildDir,
    project,
    region,
    repo,
    name = "errtraq-app",
    builder = "docker",
    tag,
    serviceAccount,
  } = options;
  if (!buildDir)
    throw new Error("--build-dir is required (the output of `errtraq build`)");
  if (!project || !region || !repo)
    throw new Error(
      "--project, --region and --repo are required (or ERRTRAQ_GCP_PROJECT, ERRTRAQ_GCP_REGION, ERRTRAQ_GCP_AR_REPO)",
    );
  if (!NAME.test(name))
    throw new Error(
      "The image name must start with errtraq- (the Docker daemon is shared)",
    );
  if (!REPO.test(repo)) throw new Error("Invalid repository name");
  if (!["docker", "cloud-build"].includes(builder))
    throw new Error("--builder must be docker or cloud-build");
  const resolvedTag = tag ?? imageTag(buildDir);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(resolvedTag))
    throw new Error("Invalid tag");
  const reference = `${region}-docker.pkg.dev/${project}/${repo}/${name}`;
  const tagged = `${reference}:${resolvedTag}`;
  const commands =
    builder === "docker"
      ? [
          {
            label: "build for linux/amd64",
            argv: [
              "docker",
              "build",
              "--platform",
              "linux/amd64",
              "-t",
              tagged,
              buildDir,
            ],
          },
          { label: "push", argv: ["docker", "push", tagged] },
        ]
      : [
          {
            label: "build and push with Cloud Build",
            argv: [
              "gcloud",
              "builds",
              "submit",
              buildDir,
              "--tag",
              tagged,
              "--project",
              project,
              "--region",
              region,
              "--format=json",
              ...(serviceAccount ? ["--service-account", serviceAccount] : []),
            ],
          },
        ];
  return { reference, tagged, tag: resolvedTag, builder, commands };
}

/** The digest out of `docker push` output or the JSON `gcloud builds submit --format=json` prints. */
export function extractDigest(output) {
  try {
    const parsed = JSON.parse(output);
    for (const build of Array.isArray(parsed) ? parsed : [parsed]) {
      const digest = build?.results?.images?.find((image) =>
        DIGEST.test(image?.digest ?? ""),
      )?.digest;
      if (digest) return digest;
    }
  } catch {
    // Not JSON (docker): fall through to the text form.
  }
  return output.match(new RegExp(`digest: (${DIGEST.source})`))?.[1];
}

export function runImage(
  options,
  {
    run = (argv) =>
      spawnSync(argv[0], argv.slice(1), {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    print = console.log,
  } = {},
) {
  const plan = planImage(options);
  if (!options.execute) {
    if (!existsSync(join(options.buildDir, "Dockerfile")) && !options.skipCheck)
      print(
        "note: the build directory has no Dockerfile yet; run `errtraq build` first",
      );
    print(`Dry run (${plan.builder}). Commands, in order:`);
    for (const command of plan.commands)
      print(`  ${command.argv.join(" ")}    # ${command.label}`);
    print(
      "Add --execute to run them. The digest-pinned reference is printed afterwards.",
    );
    return { plan, executed: false };
  }
  let digest;
  for (const command of plan.commands) {
    const result = run(command.argv);
    if (result.status !== 0)
      throw new Error(
        `${command.label} failed (exit ${result.status}): ${String(
          result.stderr ?? "",
        )
          .trim()
          .split("\n")
          .slice(-3)
          .join(" | ")}`,
      );
    digest =
      extractDigest(`${result.stdout ?? ""}`) ??
      extractDigest(`${result.stderr ?? ""}`) ??
      digest;
  }
  if (!digest)
    throw new Error(
      "The build finished but no image digest was found in its output",
    );
  const pinned = `${plan.reference}@${digest}`;
  print(`Image: ${pinned}`);
  print(`export TF_VAR_CLOUD_RUN_IMAGE='${pinned}'`);
  if (plan.builder === "docker")
    print(`Local cleanup, when done: docker rmi ${plan.tagged}`);
  return { plan, executed: true, pinned };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { flags } = parseFlags(process.argv.slice(2));
  const env = process.env;
  try {
    runImage({
      buildDir:
        typeof flags["build-dir"] === "string"
          ? resolve(flags["build-dir"])
          : undefined,
      project: flags.project ?? env.ERRTRAQ_GCP_PROJECT,
      region: flags.region ?? env.ERRTRAQ_GCP_REGION,
      repo: flags.repo ?? env.ERRTRAQ_GCP_AR_REPO,
      name: flags.name,
      builder: flags.builder,
      tag: flags.tag,
      serviceAccount: flags["cloud-build-service-account"],
      execute: flags.execute === true,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  }
}
