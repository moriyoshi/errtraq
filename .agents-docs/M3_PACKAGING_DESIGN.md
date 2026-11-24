# Packaging outside the workspace: design note

Status: design only (item 9 of the M3 queue). Nothing here is implemented. The TODO item is
"support projects that depend on errtraq packages without requiring a `pnpm-workspace.yaml`
repository or in-repository build and output directories" (M2 final review section B).

Goal: a user creates their own project, installs `@errtraq/cli` and the adapter packages from
npm, writes `stacks/prod.ts`, and runs `errtraq build` and `errtraq infra generate` there. The
generated Terraform root and the Lambda ZIPs must be usable without this repository.

## How the CLI depends on this repository today

1. **Root discovery.** `repositoryRoot` (`packages/cli/src/infra.ts`) walks up from the working
   directory to the first `pnpm-workspace.yaml` and fails without one. Default outputs are
   `<root>/dist/<stack>` and `<root>/infra/generated/<stack>`, and `safeDirectory` rejects any
   output outside that root. Error messages are scrubbed against the same root.
2. **Terraform modules.** `generateInfra` passes `modulesDirectory: <root>/infra/modules`;
   `relativeModuleSource` turns it into a relative `source` in `main.tf.json`. A consumer project
   has no `infra/modules`, and the HCL is not part of any package.
3. **Bundling.** `buildStack` runs esbuild with `resolveDir: <root>` and
   `conditions: ["development"]`, so `@errtraq/*` resolves to `./src/*.ts`. The standalone entry
   also imports `./packages/cli/src/construction.ts`, `token.ts` and `address.ts` by path.
4. **Package manifests.** Every package is `"private": true`, version `0.0.0`, with
   `workspace:*` dependencies, and `exports` lists the `development` condition first.

Stack loading itself is not coupled: `import(pathToFileURL(file))` uses Node type stripping
(available unflagged on the supported Node versions), and the stack's `@errtraq/*` imports
resolve from the user's own `node_modules`.

## Design

### Project root

Replace `repositoryRoot` with `projectRoot(stackFile, options)`:

- `--root <dir>` wins when given.
- Otherwise the nearest ancestor of the **stack file** (not the working directory) holding a
  `pnpm-workspace.yaml`, then the nearest holding a `package.json`. Inside this repository the
  workspace file is found first, so current behaviour and paths are unchanged.

`safeDirectory`, the default output locations, the absolute-path check on bundles and the error
scrubbing all keep their rules, measured against the project root. The rule "outputs stay inside
the root" stays: it is what keeps absolute local paths out of generated files.

### Terraform modules

Ship the HCL in a new package `@errtraq/terraform-modules` whose `files` are `aws/**` (later
`cloudflare/**`, ...). Its directory is found with `import.meta.resolve` on its `package.json`
from the CLI, so it follows the installed version.

Generated roots must not point into `node_modules`: Terraform often runs in a CI job without an
install, pnpm stores packages behind symlinks under a content-addressed path, and the path would
change on every upgrade. So `infra generate` gets a module mode:

| Mode | `source` in `main.tf.json` | When |
| --- | --- | --- |
| `relative` | `../../modules/aws/sqs` (today's behaviour) | Default when the modules directory is inside the project root, i.e. in this repository. |
| `vendor` | `./modules/aws/sqs` | Default otherwise. Copies only the modules the stack uses (and their child modules) into `<out>/modules/`, with a `modules/VERSION` stamp. Regeneration replaces the copy, so the root stays deterministic and self-contained. |
| `remote` | `git::https://github.com/<org>/errtraq.git//infra/modules/aws/sqs?ref=v<version>` | Opt-in via `--module-source remote`, for users who want Terraform to fetch modules itself. Needs release tags; a registry source can replace it later without changing the stack. |

The module contract tests (`infra:validate`, `infra:mutate`) run against `infra/modules` as now;
one new test generates a root in `vendor` mode into a temporary project and runs
`terraform validate` on it.

### Bundling

- Outside the workspace, esbuild uses the default conditions, so it bundles the published
  `dist/*.js`. The `development` condition is added only when the project root is this
  workspace (detected by the `pnpm-workspace.yaml` that also declares `packages/*`), keeping
  today's no-build development loop.
- `resolveDir` becomes the project root, so `@errtraq/*` resolves from the user's
  `node_modules`, the same copies the stack file imported.
- The standalone entry stops importing CLI source by path. `@errtraq/cli` gains an export
  `@errtraq/cli/standalone-entry` that exposes `constructStack`, `devToken` and `dsnOrigin`; the
  generated entry imports that specifier in both modes.

### Package manifests and release

- Drop `"private": true` on the packages meant for users: `core`, `http`, `cli`, `infra-gen`,
  every adapter and platform, and `terraform-modules`. `testing` stays private.
- Version all public packages in lockstep (one version, one git tag `v<version>`), because the
  generated entry, the adapters and the HCL modules are only tested together. `pnpm publish -r`
  rewrites `workspace:*` to the exact version.
- Use `publishConfig.exports` to publish manifests **without** the `development` condition. Some
  consumer tool chains (Vite and its plugins) set `development` themselves, and would otherwise
  resolve `./src/*.ts`, which is not in the tarball.
- `@errtraq/core` becomes a `peerDependency` of adapters, platforms and the CLI. Infra
  references are tagged with `Symbol.for`, so two copies would still interoperate there, but
  `stack-schema.ts` checks `instanceof z.ZodType`, and a second `core` (with its own `zod`) in the
  user's tree would fail that check in confusing ways. A peer dependency makes the package
  manager keep one copy, and `errtraq validate` reports when the stack's `core` and the CLI's
  `core` are not the same module.
- `prepack` runs the package build so `dist/` is present; CI checks each tarball with
  `npm pack --dry-run` for `dist/**`, no `src/**`, and no absolute paths.

### Verification

A new opt-in check (`pnpm verify:packaging`) packs every public package into
`.agents-workspace/tmp/pack/`, creates a throwaway project there with plain `npm install` of the
tarballs (no workspace file), copies `stacks/local.ts` and `stacks/aws-dynamodb.ts`, and runs:

- `errtraq validate` and `errtraq build` for both stacks; the bundles must contain no path from
  the throwaway project or the home directory;
- `errtraq infra generate` in `vendor` mode, then `terraform init -backend=false` and
  `terraform validate` on the generated root;
- the standalone bundle started once, with a single envelope posted to it.

It needs no network beyond the npm and Terraform registries already used by the gate, and skips
when those are unavailable.

## Out of scope and open questions

- Where to publish (npm organisation name, provenance, registry module) is an owner decision; this
  note assumes the `@errtraq` scope on npm.
- A project template (`npm create errtraq`) is not planned.
- Cloudflare (M6) bundles through Wrangler, not this esbuild path; its packaging is designed with
  M6.
- Whether `remote` module mode should be the default once release tags exist is left for the first
  public release.
