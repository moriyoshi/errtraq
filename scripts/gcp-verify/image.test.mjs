import { describe, expect, it } from "vitest";
import { extractDigest, imageTag, planImage, runImage } from "./image.mjs";

const base = {
  buildDir: "/work/build",
  project: "example-project",
  region: "europe-west1",
  repo: "errtraq",
  tag: "t1",
};
const digest = `sha256:${"a".repeat(64)}`;

describe("image publishing", () => {
  it("plans amd64 docker commands with errtraq-only names", () => {
    const plan = planImage(base);
    expect(plan.commands[0].argv).toEqual([
      "docker",
      "build",
      "--platform",
      "linux/amd64",
      "-t",
      "europe-west1-docker.pkg.dev/example-project/errtraq/errtraq-app:t1",
      "/work/build",
    ]);
    expect(plan.commands.map((c) => c.argv[1])).toEqual(["build", "push"]);
    expect(() => planImage({ ...base, name: "other" })).toThrow("errtraq-");
    expect(() => planImage({ ...base, builder: "podman" })).toThrow(
      "docker or cloud-build",
    );
    expect(() => planImage({ ...base, repo: undefined })).toThrow("--repo");
  });
  it("plans a Cloud Build submit", () => {
    const [command] = planImage({
      ...base,
      builder: "cloud-build",
      serviceAccount: "projects/p/serviceAccounts/x",
    }).commands;
    expect(command.argv.slice(0, 3)).toEqual(["gcloud", "builds", "submit"]);
    expect(command.argv).toContain("--service-account");
    expect(command.argv).toContain("--format=json");
  });
  it("derives a stable tag from the build manifest", () => {
    const tag = imageTag("/b", () => "{}");
    expect(tag).toMatch(/^g8-[0-9a-f]{12}$/);
    expect(imageTag("/b", () => "{}")).toBe(tag);
  });
  it("prints commands in the default dry run and runs nothing", () => {
    const lines = [];
    const ran = [];
    const result = runImage(
      { ...base, skipCheck: true },
      { run: (argv) => ran.push(argv), print: (line) => lines.push(line) },
    );
    expect(result.executed).toBe(false);
    expect(ran).toEqual([]);
    expect(lines.join("\n")).toContain("docker push");
  });
  it("executes and prints the digest-pinned reference from docker or gcloud output", () => {
    const lines = [];
    const docker = runImage(
      { ...base, execute: true },
      {
        run: (argv) => ({
          status: 0,
          stdout: argv[1] === "push" ? `latest: digest: ${digest} size: 1` : "",
          stderr: "",
        }),
        print: (line) => lines.push(line),
      },
    );
    expect(docker.pinned).toBe(
      `europe-west1-docker.pkg.dev/example-project/errtraq/errtraq-app@${digest}`,
    );
    const cloud = runImage(
      { ...base, builder: "cloud-build", execute: true },
      {
        run: () => ({
          status: 0,
          stdout: JSON.stringify([{ results: { images: [{ digest }] } }]),
          stderr: "",
        }),
        print: () => {},
      },
    );
    expect(cloud.pinned.endsWith(digest)).toBe(true);
    expect(extractDigest("nothing")).toBeUndefined();
  });
  it("fails clearly when a command fails or no digest is found", () => {
    expect(() =>
      runImage(
        { ...base, execute: true },
        { run: () => ({ status: 1, stderr: "denied" }), print: () => {} },
      ),
    ).toThrow("build for linux/amd64 failed");
    expect(() =>
      runImage(
        { ...base, execute: true },
        { run: () => ({ status: 0, stdout: "", stderr: "" }), print: () => {} },
      ),
    ).toThrow("no image digest");
  });
});
