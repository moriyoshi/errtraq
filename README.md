# errtraq

A Sentry-compatible issue tracker with pluggable storage, queues and compute. Node.js `^22.18.0 || >=23.6.0`
is required. The local stack
runs on Node and SQLite. AWS infrastructure and bundles can be generated; AWS runtime adapters
are planned for M3 and currently throw when invoked.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec errtraq validate --stack stacks/local.ts
pnpm exec errtraq dev --stack stacks/local.ts
pnpm e2e
pnpm e2e --bundle
```

For the standalone container, Docker and Node.js `^22.18.0 || >=23.6.0` are required. The generated image
uses the `node:22.23-bookworm-slim` minor line, which includes `node:sqlite` without an extra flag:

```sh
pnpm exec errtraq build --stack stacks/local.ts
docker build -t errtraq-local dist/local
docker run --rm -p 127.0.0.1:8787:8787 -v errtraq-data:/data errtraq-local
pnpm container:check
```

The Dockerfile explicitly sets `ERRTRAQ_HOST=0.0.0.0` for container networking; outside the
container the default remains `127.0.0.1`. Data is stored in `/data`, and `/health` is the
unauthenticated health endpoint. A bind-mounted data directory must be writable by the container's
user. Set the standalone `publicUrl` stack option to the externally reachable HTTP(S) origin for
the printed DSN; otherwise a wildcard listener prints a localhost DSN with a note.
`container:check` needs a Docker daemon that can mount the repository's ignored temporary
workspace (for Colima, the repository should be under the user's home directory). It skips when Docker is unavailable; otherwise
it builds an image and runs the SDK e2e on a randomly assigned loopback port.
To bump the image minor, update the tag in `packages/cli/src/build.ts`, update the Dockerfile
assertion in `packages/cli/src/build.test.ts`, then run `pnpm container:check` and the gate.

To build an AWS stack and generate its Terraform root (without applying it):

```sh
pnpm exec errtraq build --stack stacks/aws-dynamodb.ts
pnpm exec errtraq infra generate --stack stacks/aws-dynamodb.ts
pnpm infra:validate
```

Builds default to `dist/<stack>`, and generated Terraform to `infra/generated/<stack>`; both are
ignored by Git. Use `--out` to choose a directory and `--build-dir` on `infra generate` to find a
build written elsewhere. Generation requires the build unless `--allow-missing-artifacts` is
explicitly supplied. Regeneration preserves Terraform working directories, lock files, state,
plans and crash logs. Terraform state and provider credentials remain the operator's responsibility.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and `.agents-docs/QUALITY_GATE.md` for
verification commands.

When using `existing` resources, the function receives exactly the operator-supplied policy
documents; an empty document grants no access.
