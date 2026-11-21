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


### Bring-your-own RDS PostgreSQL

The Postgres stack helper supports RDS IAM authentication with
`postgres({ mode: "iam", host, port, database, user, region, resourceId })` from
`@errtraq/store-sql/postgres/stack`. Use the actual RDS, Aurora or RDS Proxy endpoint as
`host` and the `db-`, `cluster-` or `prx-` resource ID, not the database's display name.
The AWS provider account must own the named resource. The database user is restricted to a
1-63 character ASCII identifier without IAM wildcard or path characters. A fresh 15-minute token is generated on
each new connection; RDS Proxy is recommended to limit connection fan-in. The Lambda runtime
CA bundle is the default; set `sslRootCert` to a path or stack reference for a maintained PEM
bundle if using another runtime or a proxy that needs different trust roots. TLS verifies the
certificate and hostname. Existing password-secret authentication remains available.

IAM mode uses **one PostgreSQL user** for all store capabilities. The derived read, write and
delete grants each allow only `rds-db:connect` to that same user; they do not restrict SQL
operations. Configure PostgreSQL privileges for that user, and understand that any function
with its connect grant inherits all privileges held by that user. `errtraq validate` prints
this scope. The database and user are operator-provided, including RDS IAM authentication and
appropriate database privileges.

For a private database set `vpcSubnetIds` and `vpcSecurityGroupIds` together on `awsLambda`,
as literal lists of existing IDs or `string[]` stack variables. errtraq creates no VPC,
subnets, security groups, NAT gateway or endpoints. The configured subnets and security groups
must allow reaching the database. Lambda functions attached to a VPC also need NAT or suitable
VPC endpoints, DNS, route tables and security-group rules for the HTTPS calls they make to SQS,
S3, DynamoDB and Secrets Manager. In particular, gateway endpoints for S3/DynamoDB and interface
endpoints for SQS/Secrets Manager have different routing and DNS requirements. Execution roles
receive EC2 network-interface permissions on `*`, as required by Lambda; those permissions can
also be used by function code. See [AWS VPC guidance](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
for network access and the optional source-function deny defense. Test actual IAM, TLS and
network behavior in a real account before relying on it.
