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
