# errtraq

A Sentry-compatible issue tracker with pluggable storage, queues and compute. The local stack
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

For the standalone container, Docker and Node 22.13 or later are required. The generated image
uses the Node 22 major line, which includes `node:sqlite` without an extra flag:

```sh
pnpm exec errtraq build --stack stacks/local.ts
docker build -t errtraq-local dist/local
docker run --rm -p 127.0.0.1:8787:8787 -v errtraq-data:/data errtraq-local
pnpm container:check
```

The Dockerfile explicitly sets `ERRTRAQ_HOST=0.0.0.0` for container networking; outside the
container the default remains `127.0.0.1`. Data is stored in `/data`, and `/health` is the
unauthenticated health endpoint. `container:check` skips when Docker is unavailable; otherwise
it builds an image and runs the SDK e2e on a randomly assigned loopback port.

To build an AWS stack and generate its Terraform root (without applying it):

```sh
pnpm exec errtraq build --stack stacks/aws-dynamodb.ts
pnpm exec errtraq infra generate --stack stacks/aws-dynamodb.ts
pnpm infra:validate
```

Builds default to `dist/<stack>`, and generated Terraform to `infra/generated/<stack>`; both are
ignored by Git. Use `--out` to choose a directory and `--build-dir` on `infra generate` to find a
build written elsewhere. Generation requires the build unless `--allow-missing-artifacts` is
explicitly supplied. Terraform state and provider credentials remain the operator's responsibility.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and `.agents-docs/QUALITY_GATE.md` for
verification commands.
