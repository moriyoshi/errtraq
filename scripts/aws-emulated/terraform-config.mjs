import { localEndpoint } from "./client.mjs";

export function providerOverride(endpoint, version) {
  endpoint = localEndpoint(endpoint);
  if (!["6.32.1", "6.73.0"].includes(version))
    throw new Error("Unpinned AWS provider version");
  const provider = {
    region: "us-east-1",
    access_key: "emulator",
    secret_key: "emulator",
    skip_credentials_validation: true,
    skip_requesting_account_id: true,
    skip_metadata_api_check: true,
    skip_region_validation: true,
    s3_use_path_style: true,
    endpoints: Object.fromEntries(
      [
        "s3",
        "dynamodb",
        "sqs",
        "iam",
        "lambda",
        "cloudwatchlogs",
        "cloudwatch",
        "eventbridge",
        "sts",
        "ec2",
      ].map((service) => [service, endpoint]),
    ),
  };
  return {
    terraform: {
      required_providers: {
        aws: { source: "hashicorp/aws", version: `= ${version}` },
      },
    },
    provider: { aws: [provider] },
  };
}

export function terraformEnvironment(inherited, endpoint) {
  endpoint = localEndpoint(endpoint);
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) => !key.startsWith("AWS_") && !key.startsWith("TF_"),
    ),
  );
  return {
    ...env,
    AWS_ACCESS_KEY_ID: "emulator",
    AWS_SECRET_ACCESS_KEY: "emulator",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_MAX_ATTEMPTS: "1",
    AWS_ENDPOINT_URL: endpoint,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost,::1",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    all_proxy: "http://127.0.0.1:9",
    no_proxy: "127.0.0.1,localhost,::1",
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
  };
}
