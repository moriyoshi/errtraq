import {
  deriveDeployment,
  resolveStack,
  validateStack,
  variable,
} from "@moriyoshi/errtraq-core";
import { expect, it } from "vitest";
import shared from "../../../../stacks/aws-dynamodb.js";
import { awsLambda, lambdaEsbuildTarget } from "./stack.js";

it("defaults to nodejs26.x, keeps nodejs22.x selectable and rejects other runtimes", () => {
  const view = { functions: [], triggers: [] } as never;
  expect(awsLambda().config).toMatchObject({ runtime: "nodejs26.x" });
  const defaulted = awsLambda();
  expect(defaulted.infra.inputs(defaulted.config, view)).toMatchObject({
    runtime: "nodejs26.x",
  });
  expect(awsLambda({ runtime: "nodejs22.x" }).config).toMatchObject({
    runtime: "nodejs22.x",
  });
  for (const bad of ["nodejs20.x", "nodejs24.x", "python3.13", ""])
    expect(() => awsLambda({ runtime: bad as never })).toThrow(
      /nodejs22\.x, nodejs26\.x/,
    );
  expect(lambdaEsbuildTarget("nodejs22.x")).toBe("node22");
  expect(lambdaEsbuildTarget("nodejs26.x")).toBe("node26");
});
it("requires subnet and security group IDs together", () => {
  expect(() => awsLambda({ vpcSubnetIds: ["subnet-12345678"] })).toThrow();
  expect(() => awsLambda({ vpcSecurityGroupIds: ["sg-12345678"] })).toThrow();
  expect(() =>
    awsLambda({
      vpcSubnetIds: ["subnet-invalid"],
      vpcSecurityGroupIds: ["sg-12345678"],
    }),
  ).toThrow();
  expect(awsLambda().config).toMatchObject({
    vpcSubnetIds: [],
    vpcSecurityGroupIds: [],
  });
});
it("preserves stack variable references for existing VPC IDs", () => {
  const platform = awsLambda({
    vpcSubnetIds: variable("SUBNETS"),
    vpcSecurityGroupIds: variable("GROUPS"),
  });
  const stack = {
    ...Object.fromEntries(Object.entries(shared)),
    platform,
    recordMode: "direct",
    variables: {
      SUBNETS: {
        type: "string[]",
        sensitive: false,
        default: ["subnet-12345678"],
      },
      GROUPS: { type: "string[]", sensitive: false, default: ["sg-12345678"] },
    },
  };
  expect(validateStack(stack)).toEqual([]);
  expect(
    validateStack({
      ...stack,
      variables: {
        ...stack.variables,
        SUBNETS: { type: "string", sensitive: false },
      },
    }).some((issue) =>
      issue.message.includes(
        "Infrastructure config variable must have type string[]",
      ),
    ),
  ).toBe(true);
  const resolved = resolveStack(stack);
  const inputs = platform.infra.inputs(platform.config, {
    functions: [],
    triggers: [],
  } as never);
  expect(inputs.vpc_subnet_ids).toEqual(variable("SUBNETS"));
  expect(inputs.vpc_security_group_ids).toEqual(variable("GROUPS"));
  expect(resolved.platform.config).toBeDefined();
});

it("validates the per-key ingest limit including disable", () => {
  expect(awsLambda().config).toMatchObject({ rateLimit: 60 });
  expect(awsLambda({ rateLimit: null }).config).toMatchObject({
    rateLimit: null,
  });
  expect(awsLambda({ rateLimit: 1000 }).config).toMatchObject({
    rateLimit: 1000,
  });
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => awsLambda({ rateLimit: limit })).toThrow();
});

it("reserves the platform rate-limit environment name", () => {
  const stack = {
    ...Object.fromEntries(Object.entries(shared)),
    store: {
      ...shared.store,
      infra: {
        ...shared.store.infra,
        bindings: [
          ...shared.store.infra.bindings,
          {
            name: "ERRTRAQ_INGEST_RATE_LIMIT",
            kind: "env" as const,
            purpose: "primary",
            value: "1",
          },
        ],
      },
    },
  };
  expect(validateStack(stack)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining(
          "Reserved binding name ERRTRAQ_INGEST_RATE_LIMIT",
        ),
      }),
    ]),
  );
});

it("threads an optional validated alarm topic into the module inputs", () => {
  const topic = "arn:aws:sns:us-east-1:000000000000:operators";
  const view = { functions: [], triggers: [] } as never;
  expect(awsLambda().infra.inputs(awsLambda().config, view)).not.toHaveProperty(
    "alarm_topic_arn",
  );
  const platform = awsLambda({ alarmTopicArn: topic });
  expect(platform.infra.inputs(platform.config, view)).toMatchObject({
    alarm_topic_arn: topic,
  });
  for (const bad of [
    "arn:aws:sqs:us-east-1:000000000000:operators",
    "arn:aws:sns:us-east-1:12:operators",
    "operators",
    "",
  ])
    expect(() => awsLambda({ alarmTopicArn: bad })).toThrow();
});

it("accepts an existing artifact bucket or a stack variable", () => {
  expect(
    awsLambda({ artifactBucket: "deployment-artifacts-123" }).config,
  ).toMatchObject({ artifactBucket: "deployment-artifacts-123" });
  expect(() => awsLambda({ artifactBucket: "INVALID" })).toThrow();
  const platform = awsLambda({ artifactBucket: variable("ARTIFACT_BUCKET") });
  const stack = {
    ...Object.fromEntries(Object.entries(shared)),
    platform,
    recordMode: "direct" as const,
    variables: {
      ARTIFACT_BUCKET: {
        type: "string" as const,
        sensitive: false,
        default: "deployment-artifacts-123",
      },
    },
  };
  expect(validateStack(stack)).toEqual([]);
  expect(
    platform.infra.inputs(platform.config, { functions: [], triggers: [] })
      .artifact_bucket,
  ).toEqual(variable("ARTIFACT_BUCKET"));
});

const direct = (platform: ReturnType<typeof awsLambda>, variables = {}) =>
  deriveDeployment(
    resolveStack({
      ...Object.fromEntries(Object.entries(shared)),
      platform,
      recordMode: "direct",
      variables,
    }),
  );
it("passes the public ingest URL and API CORS origins to the module, never to the app", () => {
  const plain = awsLambda();
  expect(plain.infra.inputs(plain.config, direct(plain))).not.toHaveProperty(
    "ingest_public_url",
  );
  const options = {
    publicIngestUrl: "https://ingest.example.test",
    apiCorsOrigins: ["https://ui.example.test"],
  };
  const platform = awsLambda(options);
  expect(
    platform.infra.inputs(platform.config, direct(platform)),
  ).toMatchObject({
    ingest_public_url: "https://ingest.example.test",
    api_cors_origins: ["https://ui.example.test"],
  });
  // CORS belongs on a function URL of its own: the ingest URL's policy is public.
  const sharedFn = awsLambda({ ...options, split: [] });
  expect(() =>
    sharedFn.infra.inputs(sharedFn.config, direct(sharedFn)),
  ).toThrow(/function of its own/);
  const noApi = awsLambda({ ...options, http: ["ingest"] });
  expect(() => noApi.infra.inputs(noApi.config, direct(noApi))).toThrow(
    /exposed over HTTP/,
  );
  for (const bad of [
    "*",
    "https://ui.example.test/",
    "https://ui.example.test/x",
    "ui.example.test",
    "ftp://ui.example.test",
  ])
    expect(() => awsLambda({ apiCorsOrigins: [bad] })).toThrow();
  expect(() => awsLambda({ apiCorsOrigins: [] })).toThrow();
  for (const bad of [
    "ingest.example.test",
    "https://u:p@ingest.example.test",
    "https://ingest.example.test/?x=1",
    "https://ingest.example.test/#x",
  ])
    expect(() => awsLambda({ publicIngestUrl: bad })).toThrow();
});
it("accepts stack variables for the public ingest URL and API CORS origins and reserves the env name", () => {
  const platform = awsLambda({
    publicIngestUrl: variable("INGEST_URL"),
    apiCorsOrigins: variable("UI_ORIGINS"),
  });
  const variables = {
    INGEST_URL: {
      type: "string" as const,
      sensitive: false,
      default: "https://ingest.example.test",
    },
    UI_ORIGINS: {
      type: "string[]" as const,
      sensitive: false,
      default: ["https://ui.example.test"],
    },
  };
  const stack = {
    ...Object.fromEntries(Object.entries(shared)),
    platform,
    recordMode: "direct" as const,
    variables,
  };
  expect(validateStack(stack)).toEqual([]);
  expect(
    validateStack({
      ...stack,
      variables: {
        ...variables,
        UI_ORIGINS: { type: "string" as const, sensitive: false },
      },
    }).some((issue) => issue.message.includes("must have type string[]")),
  ).toBe(true);
  const inputs = platform.infra.inputs(
    platform.config,
    direct(platform, variables),
  );
  expect(inputs.ingest_public_url).toEqual(variable("INGEST_URL"));
  expect(inputs.api_cors_origins).toEqual(variable("UI_ORIGINS"));
  expect(platform.manifest.reservedBindings).toContain(
    "ERRTRAQ_PUBLIC_INGEST_URL",
  );
});
it("hosts the web UI from the API function's build output and rejects what CloudFront cannot reach", () => {
  const plain = awsLambda();
  expect(plain.infra.inputs(plain.config, direct(plain))).not.toHaveProperty(
    "ui",
  );
  const platform = awsLambda({
    ui: { directory: "../packages/ui/dist", priceClass: "PriceClass_All" },
  });
  const inputs = platform.infra.inputs(platform.config, direct(platform));
  expect(inputs.ui).toEqual({
    build_anchor: expect.objectContaining({ functionId: "api" }),
    price_class: "PriceClass_All",
  });
  expect(awsLambda({ ui: { directory: "dist" } }).config).toMatchObject({
    ui: { priceClass: "PriceClass_100" },
  });
  expect(platform.infra.module.outputs).toMatchObject({
    ui_domain_name: "string",
    ui_distribution_id: "string",
    ui_bucket_name: "string",
  });
  // The API must be reachable over HTTP, and its function URL public (CloudFront cannot send the
  // Bearer token through origin access control).
  expect(() =>
    awsLambda({ ui: { directory: "dist" }, http: ["ingest"] }),
  ).toThrow(/api role to be exposed over HTTP/);
  expect(() =>
    awsLambda({
      ui: { directory: "dist" },
      roles: ["ingest", "consumer", "cron"],
      split: ["ingest", "consumer", "cron"],
      http: ["ingest"],
    }),
  ).toThrow();
  const iam = awsLambda({
    ui: { directory: "dist" },
    settings: { api: { urlAuth: "AWS_IAM" } },
  });
  expect(() => iam.infra.inputs(iam.config, direct(iam))).toThrow(
    /without IAM authorization/,
  );
  for (const bad of [{ directory: "" }, { directory: "x", priceClass: "Mars" }])
    expect(() => awsLambda({ ui: bad as never })).toThrow();
});
const CERT =
  "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";
const WAF =
  "arn:aws:wafv2:us-east-1:123456789012:global/webacl/errtraq/11111111-2222-3333-4444-555555555555";
it("delivers an explicit public API URL as a module input and reserves its environment name", () => {
  const platform = awsLambda({ publicApiUrl: "https://errtraq.example.com" });
  expect(
    platform.infra.inputs(platform.config, direct(platform)).public_api_url,
  ).toBe("https://errtraq.example.com");
  const variables = awsLambda({ publicApiUrl: variable("API_URL") });
  expect(
    variables.infra.inputs(
      variables.config,
      direct(variables, {
        API_URL: {
          type: "string" as const,
          sensitive: false,
          default: "https://errtraq.example.com",
        },
      }),
    ).public_api_url,
  ).toEqual(variable("API_URL"));
  expect(variables.manifest.reservedBindings).toContain(
    "ERRTRAQ_PUBLIC_API_URL",
  );
  expect(variables.manifest.infrastructureConfigReferences?.publicApiUrl).toBe(
    "string",
  );
  const none = awsLambda();
  expect(none.infra.inputs(none.config, direct(none))).not.toHaveProperty(
    "public_api_url",
  );
  for (const bad of [
    "https://errtraq.example.com/api",
    "https://errtraq.example.com/",
    "https://u:p@errtraq.example.com",
    "ftp://errtraq.example.com",
    "errtraq.example.com",
  ])
    expect(() => awsLambda({ publicApiUrl: bad })).toThrow();
});
it("serves the UI on custom domains with the operator's certificate and web ACL", () => {
  const platform = awsLambda({
    ui: {
      directory: "dist",
      aliases: ["errtraq.example.com", "ui.example.com"],
      certificateArn: CERT,
      wafAclArn: WAF,
    },
  });
  const inputs = platform.infra.inputs(platform.config, direct(platform));
  expect(inputs.ui).toMatchObject({
    aliases: ["errtraq.example.com", "ui.example.com"],
    certificate_arn: CERT,
    waf_acl_arn: WAF,
  });
  // The first alias is the default public API URL; an explicit setting wins.
  expect(inputs.public_api_url).toBe("https://errtraq.example.com");
  const explicit = awsLambda({
    publicApiUrl: "https://api.example.com",
    ui: {
      directory: "dist",
      aliases: ["errtraq.example.com"],
      certificateArn: CERT,
    },
  });
  expect(
    explicit.infra.inputs(explicit.config, direct(explicit)).public_api_url,
  ).toBe("https://api.example.com");
  const plain = awsLambda({ ui: { directory: "dist" } });
  const plainInputs = plain.infra.inputs(plain.config, direct(plain));
  expect(plainInputs.ui).not.toHaveProperty("aliases");
  expect(plainInputs).not.toHaveProperty("public_api_url");
});
it("validates aliases, the us-east-1 certificate and the web ACL", () => {
  const ui = (extra: object) =>
    awsLambda({ ui: { directory: "dist", ...extra } as never });
  expect(() => ui({ aliases: ["errtraq.example.com"] })).toThrow(/go together/);
  expect(() => ui({ certificateArn: CERT })).toThrow(/go together/);
  expect(() =>
    ui({
      aliases: ["errtraq.example.com"],
      certificateArn: CERT.replace("us-east-1", "eu-west-1"),
    }),
  ).toThrow(/us-east-1/);
  expect(() =>
    ui({
      aliases: ["errtraq.example.com"],
      certificateArn: CERT,
      wafAclArn: WAF.replace("global", "regional"),
    }),
  ).toThrow(/wafAclArn/);
  expect(() =>
    ui({
      aliases: ["errtraq.example.com"],
      certificateArn: CERT,
      wafAclArn: WAF.replace("us-east-1", "eu-west-1"),
    }),
  ).toThrow(/wafAclArn/);
  for (const aliases of [
    ["Errtraq.example.com"],
    ["*.example.com"],
    ["example"],
    ["errtraq.example.com."],
    ["a.example.com", "a.example.com"],
    [],
  ])
    expect(() => ui({ aliases, certificateArn: CERT })).toThrow();
});
const grant = {
  claim: "groups",
  value: "viewers",
  org: "default",
  scopes: ["event:read" as const],
};
it("counts the public URLs with the sign-in settings against Lambda's 4 KB", () => {
  const platform = awsLambda({
    publicApiUrl: "https://errtraq.example.com",
    publicIngestUrl: "https://ingest.example.com/prefix",
    oidc: {
      issuer: "https://idp.example.com",
      audience: "errtraq",
      grants: Array.from({ length: 12 }, (_, i) => ({
        ...grant,
        value: `g${i}`,
      })),
    },
  });
  const view = direct(platform);
  expect(() => platform.infra.inputs(platform.config, view)).not.toThrow();
  // The same settings next to adapter bindings that leave too little room are refused. The
  // sign-in settings alone are capped at 3072 bytes; the rest of the budget is shared.
  const api = view.functions.find((fn) => fn.http.includes("api"));
  api?.envBindings.push({
    binding: { name: "BIG", kind: "env", value: "x".repeat(3500) },
  } as never);
  expect(() => platform.infra.inputs(platform.config, view)).toThrow(/4096/);
});

it("delivers OIDC and signed proxy settings as one JSON-able module input and reserves the env name", () => {
  const platform = awsLambda({
    oidc: {
      issuer: variable("OIDC_ISSUER"),
      audience: "errtraq",
      grants: [grant],
    },
    proxyAuth: {
      kind: "signed",
      preset: "google-iap",
      audience: "/projects/1/global/backendServices/2",
      grants: [grant],
    },
  });
  const inputs = platform.infra.inputs(
    platform.config,
    direct(platform, {
      OIDC_ISSUER: {
        type: "string" as const,
        sensitive: false,
        default: "https://idp.example.test",
      },
    }),
  );
  expect(inputs.auth_config).toMatchObject({
    oidc: { issuer: variable("OIDC_ISSUER"), audience: "errtraq" },
    proxy: { kind: "signed", preset: "google-iap" },
  });
  expect(platform.manifest.reservedBindings).toContain("ERRTRAQ_AUTH_CONFIG");
  const plain = awsLambda();
  expect(plain.infra.inputs(plain.config, direct(plain))).not.toHaveProperty(
    "auth_config",
  );
});
it("rejects invalid sign-in settings at stack validation", () => {
  const ok = {
    issuer: "https://idp.example.test",
    audience: "a",
    grants: [grant],
  };
  expect(() => awsLambda({ oidc: ok })).not.toThrow();
  for (const bad of [
    { ...ok, issuer: "http://idp.example.test" },
    { ...ok, issuer: "idp.example.test" },
    { ...ok, grants: [] },
    { ...ok, grants: [{ ...grant, value: "team-*" }] },
    { ...ok, grants: [{ ...grant, scopes: ["org:read"] }] },
    { ...ok, grants: [{ ...grant, scopes: [] }] },
    { ...ok, algorithms: ["HS256"] },
    { ...ok, extra: 1 },
  ])
    expect(() => awsLambda({ oidc: bad as never })).toThrow();
  expect(() => awsLambda({ oidc: ok, http: ["ingest"] })).toThrow(
    /api role exposed over HTTP/,
  );
});
it("refuses unsigned identity headers on Lambda, whatever the function URL authorization", () => {
  const unsigned = {
    kind: "unsigned" as const,
    trustUnsignedHeaders: true as const,
    preset: "oauth2-proxy" as const,
    secretHeader: "x-errtraq-proxy-secret",
    secret: variable("PROXY_SECRET"),
    grants: [grant],
  };
  expect(() => awsLambda({ proxyAuth: unsigned })).toThrow(
    /not supported on AWS Lambda/,
  );
  expect(() =>
    awsLambda({
      proxyAuth: unsigned,
      settings: { api: { urlAuth: "AWS_IAM" } },
    }),
  ).toThrow(/not supported on AWS Lambda/);
});
it("rejects an oversized sign-in config before Terraform sees it", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    ...grant,
    value: `group-with-a-rather-long-name-${i}-${"x".repeat(40)}`,
  }));
  expect(() =>
    awsLambda({
      oidc: { issuer: "https://idp.example.test", audience: "a", grants: many },
    }),
  ).toThrow(/3072 bytes/);
});
