# RDS PostgreSQL test fixture

A Terraform module for TESTS ONLY (the third real AWS run, see `.agents-docs/M3H_RUN3_PLAN.md`).
It is not a product module: the Postgres store takes an existing database, and no adapter may
reference this directory. Nothing under `infra/fixtures` is generated into or imported by a stack.

## What it creates

- RDS for PostgreSQL (major 17 by default), single-AZ, `db.t4g.micro`, gp3 storage, encrypted,
  IAM database authentication on, `rds.force_ssl = 1` through a parameter group, master password
  managed by RDS in Secrets Manager, not public, no deletion protection, no final snapshot, and
  automated backups off (`backup_retention_period = 0`, so there is no point-in-time recovery).
- An RDS Proxy (`create_proxy`, default true): engine family POSTGRESQL, TLS required, IAM
  authentication required, its own IAM role that reads only the master secret, default target group
  targeting the instance.
- Security groups: the database accepts TCP 5432 from the Lambda security group and the proxy
  security group only; the proxy accepts 5432 from the Lambda security group only.
- Every taggable resource carries `errtraq:fixture = rds-postgres` plus the `tags` input, so teardown
  can be verified by listing resources with that tag.

## Network modes

Created (default, `vpc_id = null`): a VPC (`vpc_cidr`), two private subnets in the first two
available AZs, no NAT and no internet gateway, gateway endpoints for S3 and DynamoDB on the private
route table, interface endpoints (private DNS on) for SQS and Secrets Manager behind their own
security group that allows 443 from the Lambda security group, and a Lambda security group.

Bring your own: set `vpc_id` and `subnet_ids`, and optionally `lambda_security_group_id` (when null
a Lambda security group is created in that VPC). No VPC, subnet, route or endpoint is created.
Partial inputs are rejected at plan time. You must provide:

- at least two subnets in two different AZs (a DB subnet group requires it);
- egress from the Lambda to SQS, S3, DynamoDB and Secrets Manager, through a NAT or VPC endpoints;
- when you supply the Lambda security group, egress from it to the database and proxy on 5432.

## Cost

Roughly 0.02 USD per hour for `db.t4g.micro` plus 20 GiB gp3, about 0.015 USD per hour for the
proxy (billed per vCPU of the instance, with a two-vCPU minimum), and about 0.01 USD per hour per
interface endpoint per AZ (four endpoint ENIs in created mode). Expect on the order of 0.10 USD per
hour in total. Prices vary by region; destroy when done.

## Teardown

`terraform destroy` removes everything, including the instance (no snapshot is kept). The master
secret is scheduled for deletion by RDS. Afterwards, list resources by the `errtraq:fixture` tag to
confirm nothing is left.

## Tests

`tests/contract.tftest.hcl` uses `mock_provider`, so it runs offline. `pnpm infra:validate` runs
`terraform validate` and the tests at both pinned AWS provider versions.
