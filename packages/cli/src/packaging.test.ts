import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stackOrigin } from "@moriyoshi/errtraq-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import shared from "../../../stacks/aws-dynamodb.js";
import { generateInfra, isErrtraqWorkspace, projectRoot } from "./infra.js";
import { moduleClosure, vendorModules } from "./modules.js";

const repo = process.cwd();
let temp: string;
async function put(path: string, content = ""): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}
beforeAll(async () => {
  await mkdir(resolve(repo, ".agents-workspace/tmp"), { recursive: true });
  temp = await realpath(
    await mkdtemp(resolve(repo, ".agents-workspace/tmp/packaging-test-")),
  );
});
afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
describe("project root", () => {
  it("prefers --root, then the nearest workspace file, then package.json", async () => {
    const workspace = join(temp, "ws");
    await put(join(workspace, "pnpm-workspace.yaml"));
    await put(join(workspace, "app/package.json"), "{}");
    await put(join(workspace, "app/stacks/prod.ts"));
    expect(await projectRoot(join(workspace, "app/stacks/prod.ts"))).toBe(
      workspace,
    );
    expect(
      await projectRoot(join(workspace, "app/stacks/prod.ts"), {
        root: join(workspace, "app"),
      }),
    ).toBe(join(workspace, "app"));
    await expect(
      projectRoot(join(workspace, "app/stacks/prod.ts"), {
        root: join(workspace, "missing"),
      }),
    ).rejects.toThrow("--root");
  });
  it("falls back to the nearest package.json outside any workspace", async () => {
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "errtraq-root-")),
    );
    try {
      await put(join(outside, "package.json"), "{}");
      await put(join(outside, "nested/package.json"), "{}");
      await put(join(outside, "nested/stacks/prod.ts"));
      expect(await projectRoot(join(outside, "nested/stacks/prod.ts"))).toBe(
        join(outside, "nested"),
      );
      await symlink(
        join(outside, "nested/stacks/prod.ts"),
        join(outside, "link.ts"),
      );
      expect(await projectRoot(join(outside, "link.ts"))).toBe(
        join(outside, "nested"),
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("recognises only this workspace as the errtraq workspace", async () => {
    expect(await isErrtraqWorkspace(repo)).toBe(true);
    expect(await isErrtraqWorkspace(temp)).toBe(false);
    const other = join(temp, "other-ws");
    await put(join(other, "pnpm-workspace.yaml"));
    await put(join(other, "packages/core/package.json"), '{"name":"core"}');
    expect(await isErrtraqWorkspace(other)).toBe(false);
  });
});
describe("vendored Terraform modules", () => {
  async function fixture(): Promise<string> {
    const root = join(temp, `modules-${Math.random().toString(36).slice(2)}`);
    await put(
      join(root, "aws/a/main.tf"),
      'module "c" {\n  source = "../shared"\n}\n',
    );
    await put(join(root, "aws/a/versions.tf"), 'source  = "hashicorp/aws"\n');
    await put(join(root, "aws/a/tests/contract.tftest.hcl"));
    await put(join(root, "aws/a/data.json"), "{}");
    await put(
      join(root, "aws/shared/main.tf"),
      'module "d" {\n  source = "../../common/d"\n}\n',
    );
    await put(join(root, "common/d/main.tf"));
    await put(join(root, "aws/unused/main.tf"));
    return root;
  }
  it("follows relative child module sources", async () => {
    const root = await fixture();
    expect(
      await moduleClosure(root, [{ provider: "aws", component: "a" }]),
    ).toEqual(["aws/a", "aws/shared", "common/d"]);
    await put(join(root, "aws/escape/main.tf"), 'source = "../../../x"\n');
    await expect(
      moduleClosure(root, [{ provider: "aws", component: "escape" }]),
    ).rejects.toThrow("outside the modules directory");
    await expect(
      moduleClosure(root, [{ provider: "aws", component: "nope" }]),
    ).rejects.toThrow("not found");
  });
  it("copies only the closure, without tests, and stamps the version", async () => {
    const root = await fixture();
    const target = join(temp, "vendor-out/modules");
    await vendorModules(
      root,
      target,
      [{ provider: "aws", component: "a" }],
      "1.2.3",
    );
    expect((await readdir(target)).sort()).toEqual([
      "VERSION",
      "aws",
      "common",
    ]);
    expect((await readdir(join(target, "aws"))).sort()).toEqual([
      "a",
      "shared",
    ]);
    expect((await readdir(join(target, "aws/a"))).sort()).toEqual([
      "data.json",
      "main.tf",
      "versions.tf",
    ]);
    expect(await readFile(join(target, "VERSION"), "utf8")).toBe("1.2.3\n");
  });
  const modulesDirectory = resolve(repo, "infra/modules");
  async function generate(
    name: string,
    options: Parameters<typeof generateInfra>[5],
  ): Promise<string> {
    const project = join(temp, name);
    await mkdir(project, { recursive: true });
    await generateInfra(
      shared,
      project,
      join(project, "out"),
      join(project, "dist"),
      true,
      { modulesDirectory, moduleVersion: "1.2.3", ...options },
    );
    return join(project, "out");
  }
  it("generates a self-contained vendor root and replaces only modules on regeneration", async () => {
    const out = await generate("vendor", { moduleSource: "vendor" });
    const main = JSON.parse(await readFile(join(out, "main.tf.json"), "utf8"));
    const sources = Object.values(main.module).map(
      (m) => (m as { source: string }).source,
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toMatch(/^\.\/modules\/aws\/[a-z0-9-]+$/);
      expect((await readdir(join(out, source))).length).toBeGreaterThan(0);
    }
    expect(await readFile(join(out, "modules/VERSION"), "utf8")).toBe(
      "1.2.3\n",
    );
    expect(await readdir(join(out, "modules/aws/dynamodb"))).toContain(
      "indexes.json",
    );
    expect(await readdir(join(out, "modules/aws/dynamodb"))).not.toContain(
      "tests",
    );
    expect(JSON.stringify(main)).not.toContain(repo);
    await put(join(out, "modules/stale.txt"), "x");
    await put(join(out, "terraform.tfstate"), "keep");
    const project = join(temp, "vendor");
    await generateInfra(shared, project, out, join(project, "dist"), true, {
      modulesDirectory,
      moduleVersion: "1.2.4",
      moduleSource: "vendor",
    });
    expect(await readdir(join(out, "modules"))).not.toContain("stale.txt");
    expect(await readFile(join(out, "modules/VERSION"), "utf8")).toBe(
      "1.2.4\n",
    );
    expect(await readFile(join(out, "terraform.tfstate"), "utf8")).toBe("keep");
    await generateInfra(shared, project, out, join(project, "dist"), true, {
      modulesDirectory,
      moduleVersion: "1.2.4",
      moduleSource: "remote",
      moduleBase: "git::https://example.com/o/r.git//infra/modules",
    });
    expect(await readdir(out)).not.toContain("modules");
  });
  it("refuses a modules directory the generator does not own", async () => {
    const project = join(temp, "unowned");
    await mkdir(project, { recursive: true });
    const out = join(project, "out");
    await generateInfra(shared, project, out, join(project, "dist"), true, {
      modulesDirectory,
      moduleSource: "relative",
    });
    await put(join(out, "modules/mine.txt"), "x");
    await expect(
      generateInfra(shared, project, out, join(project, "dist"), true, {
        modulesDirectory,
        moduleVersion: "1.2.3",
        moduleSource: "vendor",
      }),
    ).rejects.toThrow("not owned by the generator");
    expect(await readFile(join(out, "modules/mine.txt"), "utf8")).toBe("x");
  });
  it("renders remote sources and validates the module options", async () => {
    const out = await generate("remote", {
      moduleSource: "remote",
      moduleBase: "git::https://example.com/o/r.git//infra/modules",
    });
    const main = JSON.parse(await readFile(join(out, "main.tf.json"), "utf8"));
    for (const block of Object.values(main.module))
      expect((block as { source: string }).source).toMatch(
        /^git::https:\/\/example\.com\/o\/r\.git\/\/infra\/modules\/aws\/[a-z0-9-]+\?ref=v1\.2\.3$/,
      );
    expect(await readdir(out)).not.toContain("modules");
    await expect(
      generate("remote-none", { moduleSource: "remote" }),
    ).rejects.toThrow("requires --module-base");
    await expect(
      generate("remote-local", {
        moduleSource: "remote",
        moduleBase: "../modules",
      }),
    ).rejects.toThrow("Module base");
    await expect(
      generate("base-only", { moduleBase: "github.com/o/r//m" }),
    ).rejects.toThrow("requires --module-source remote");
  });
  it("defaults to relative inside the project root and vendor outside it", async () => {
    const sources = async (out: string) =>
      Object.values(
        JSON.parse(await readFile(join(out, "main.tf.json"), "utf8")).module,
      ).map((block) => (block as { source: string }).source);
    for (const source of await sources(await generate("default-outside", {})))
      expect(source).toMatch(/^\.\/modules\/aws\//);
    const inside = join(temp, "default-inside");
    await cp(modulesDirectory, join(inside, "infra/modules"), {
      recursive: true,
    });
    const out = await generate("default-inside", {
      modulesDirectory: join(inside, "infra/modules"),
    });
    for (const source of await sources(out))
      expect(source).toMatch(/^\.\.\/infra\/modules\/aws\//);
    expect(await readdir(out)).not.toContain("modules");
    const installed = join(temp, "default-installed");
    await cp(
      modulesDirectory,
      join(installed, "node_modules/@moriyoshi/errtraq-terraform-modules"),
      {
        recursive: true,
      },
    );
    for (const source of await sources(
      await generate("default-installed", {
        modulesDirectory: join(
          installed,
          "node_modules/@moriyoshi/errtraq-terraform-modules",
        ),
      }),
    ))
      expect(source).toMatch(/^\.\/modules\/aws\//);
  });
});
describe("core identity", () => {
  it("reports whether a stack was resolved by this core", () => {
    expect(stackOrigin(shared)).toBe("this-core");
    expect(stackOrigin({ name: "plain" })).toBe("unresolved");
    expect(stackOrigin({ ...shared })).toBe("other-core");
  });
});
