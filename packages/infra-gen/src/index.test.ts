import {
  artifact,
  configReference,
  constructDeployedStack,
  containsLocalPath,
  deriveDeployment,
  env,
  generationEnv,
  out,
  output,
  type ResolvedStack,
  resolveStack,
  type StackConfig,
  stackValue,
  validateStack,
  variable,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import shared from "../../../stacks/aws-dynamodb.js";
import archiveExample from "../../../stacks/aws-dynamodb-archive.js";
import perTopic from "../../../stacks/aws-dynamodb-per-topic.js";
import local from "../../../stacks/local.js";
import {
  type GenerateOptions,
  generate,
  moduleSource,
  relativeModuleSource,
  renderInfraValue,
} from "./index.js";

const options: GenerateOptions = {
  outputDirectory: "infra/generated/example",
  modulesDirectory: "infra/modules",
  generationEnv: {},
  artifactPaths: Object.fromEntries(
    ["ingest", "api", "consumer", "record", "cron", "archive", "shared"].map(
      (id) => [id, `build/${id}.zip`],
    ),
  ),
};
const raw = (stack: StackConfig): StackConfig =>
  Object.fromEntries(Object.entries(stack)) as StackConfig;
function terraform(
  stack: ResolvedStack,
  opts = options,
): Record<string, string> {
  const result = generate(stack, opts);
  if (result.kind !== "terraform") throw new Error(result.reason);
  return result.files;
}
function parsed(
  files: Record<string, string>,
  name: string,
): Record<string, unknown> {
  const file = files[name];
  if (!file) throw new Error(`missing ${name}`);
  return JSON.parse(file);
}
describe("Terraform generator", () => {
  it.each([
    [42, "42"],
    [null, "disabled"],
  ] as const)(
    "delivers Lambda rate limit %s only to ingest HTTP functions",
    (rateLimit, value) => {
      const base = raw(shared);
      base.platform = {
        ...base.platform,
        config: {
          ...(base.platform.config as Record<string, unknown>),
          rateLimit,
        },
      };
      const files = terraform(resolveStack(base));
      const main = parsed(files, "main.tf.json") as {
        module: {
          platform: {
            functions: Record<string, { environment: Record<string, string> }>;
          };
        };
      };
      expect(
        main.module.platform.functions.ingest?.environment
          .ERRTRAQ_INGEST_RATE_LIMIT,
      ).toBe(value);
      expect(
        main.module.platform.functions.api?.environment,
      ).not.toHaveProperty("ERRTRAQ_INGEST_RATE_LIMIT");
      expect(
        main.module.platform.functions.consumer?.environment,
      ).not.toHaveProperty("ERRTRAQ_INGEST_RATE_LIMIT");
    },
  );
  it("delivers runtime config references to precisely the functions using their adapter", async () => {
    const base = raw(shared);
    base.variables = {
      PUBLIC: { type: "json", sensitive: false, default: { enabled: true } },
    };
    base.store = {
      ...base.store,
      manifest: {
        ...base.store.manifest,
        configSchema: z.strictObject({
          path: configReference(z.string()),
          options: configReference(z.unknown()),
        }),
      },
      config: {
        path: env("STORE_PATH", { defaultValue: "fallback" }),
        options: variable("PUBLIC"),
      },
    };
    const stack = resolveStack(base);
    const fn = deriveDeployment(stack).functions.find(
      (item) => item.id === "ingest",
    );
    expect(fn?.envBindings.map((item) => item.binding.name)).toEqual(
      expect.arrayContaining([
        "ERRTRAQ_CONFIG_ENV_STORE_PATH",
        "ERRTRAQ_CONFIG_VAR_PUBLIC",
      ]),
    );
    // The cron role uses the store too (bundle-cleanup), so it receives the same reference.
    expect(
      deriveDeployment(stack)
        .functions.find((item) => item.id === "cron")
        ?.envBindings.map((item) => item.binding.name),
    ).toContain("ERRTRAQ_CONFIG_ENV_STORE_PATH");
    const files = terraform(stack);
    expect(files["main.tf.json"]).toContain(
      "$" + "{var.errtraq_env_STORE_PATH}",
    );
    expect(files["main.tf.json"]).toContain("$" + "{var.PUBLIC}");
    expect(parsed(files, "variables.tf.json")).toMatchObject({
      variable: {
        errtraq_env_STORE_PATH: { type: "string", default: "fallback" },
      },
    });
    let config: unknown;
    const envs = Object.fromEntries(
      (fn?.envBindings ?? []).map((item) => [
        item.binding.name,
        item.binding.name === "ERRTRAQ_CONFIG_ENV_STORE_PATH"
          ? ""
          : item.binding.name === "ERRTRAQ_CONFIG_VAR_PUBLIC"
            ? '{"enabled":true}'
            : "value",
      ]),
    );
    const built = await constructDeployedStack(
      stack,
      "ingest",
      envs,
      async (name) => ({
        create: (context: { config: unknown }) => {
          if (name === stack.store.runtimeModule) config = context.config;
          return {};
        },
      }),
    );
    expect(config).toEqual({ path: "", options: { enabled: true } });
    await built.close();
  });
  it("encodes config variables as strings and rejects sensitive or colliding references", () => {
    const base = raw(shared);
    base.variables = {
      ITEMS: { type: "string[]", sensitive: false, default: ["a"] },
      FLAG: { type: "bool", sensitive: false, default: true },
      NUMBER: { type: "number", sensitive: false, default: 7 },
      SECRET: { type: "string", sensitive: true },
    };
    base.store = {
      ...base.store,
      manifest: {
        ...base.store.manifest,
        configSchema: z.strictObject({
          items: configReference(z.unknown()),
          flag: configReference(z.unknown()),
          number: configReference(z.unknown()),
        }),
      },
      config: {
        items: variable("ITEMS"),
        flag: variable("FLAG"),
        number: variable("NUMBER"),
      },
    };
    const result = terraform(resolveStack(base))["main.tf.json"];
    expect(result).toContain("$" + "{jsonencode(var.ITEMS)}");
    expect(result).toContain("$" + "{tostring(var.FLAG)}");
    expect(result).toContain("$" + "{tostring(var.NUMBER)}");
    base.store = {
      ...base.store,
      config: {
        items: variable("SECRET"),
        flag: variable("FLAG"),
        number: variable("NUMBER"),
      },
    };
    expect(
      validateStack(base).some((issue) =>
        issue.message.includes("Sensitive variables"),
      ),
    ).toBe(true);
    base.store = {
      ...base.store,
      config: {
        items: env("AWS_REGION"),
        flag: variable("FLAG"),
        number: variable("NUMBER"),
      },
    };
    expect(validateStack(base)).toEqual([]);
  });
  it("shares one runtime binding for the same environment input and rejects conflicting defaults", () => {
    const base = raw(shared);
    base.store = {
      ...base.store,
      manifest: {
        ...base.store.manifest,
        configSchema: z.strictObject({
          first: configReference(z.string()),
          second: configReference(z.string()),
        }),
      },
      config: {
        first: env("DATA", { defaultValue: "x", suffix: "/a" }),
        second: env("DATA", { defaultValue: "x", suffix: "/b" }),
      },
    };
    const stack = resolveStack(base);
    const fn = deriveDeployment(stack).functions.find(
      (item) => item.id === "ingest",
    );
    expect(
      fn?.envBindings.filter(
        (item) => item.binding.name === "ERRTRAQ_CONFIG_ENV_DATA",
      ),
    ).toHaveLength(1);
    base.store = {
      ...base.store,
      config: {
        first: env("DATA", { defaultValue: "x" }),
        second: env("DATA", { defaultValue: "y" }),
      },
    };
    expect(
      validateStack(base).some((issue) =>
        issue.message.includes("Conflicting defaults"),
      ),
    ).toBe(true);
    base.store = {
      ...base.store,
      config: { first: env("DATA"), second: env("DATA") },
      infra: {
        ...base.store.infra,
        bindings: [
          ...base.store.infra.bindings,
          {
            name: "ERRTRAQ_CONFIG_ENV_DATA",
            kind: "env",
            purpose: "primary",
            value: "other",
          },
        ],
      },
    };
    expect(
      validateStack(base).some((issue) =>
        issue.message.includes("Duplicate binding ERRTRAQ_CONFIG_ENV_DATA"),
      ),
    ).toBe(true);
  });
  it("escapes Terraform syntax in generated runtime environment defaults", () => {
    const base = raw(shared);
    base.store = {
      ...base.store,
      manifest: {
        ...base.store.manifest,
        configSchema: z.strictObject({ path: configReference(z.string()) }),
      },
      config: { path: env("DATA", { defaultValue: "$" + "{literal}" }) },
    };
    const files = terraform(resolveStack(base));
    expect(parsed(files, "variables.tf.json")).toMatchObject({
      variable: { errtraq_env_DATA: { default: "$" + "$" + "{literal}" } },
    });
  });
  it("rejects a __proto__ variable instead of silently dropping it", () => {
    const base = raw(shared);
    base.variables = Object.fromEntries([
      ["__proto__", { type: "string", sensitive: false, default: "owned" }],
    ]);
    expect(validateStack(base)).toContainEqual({
      path: "variables.__proto__",
      message: "Reserved identifier __proto__",
    });
    expect(() => resolveStack(base)).toThrow("variables.__proto__");
  });
  it("omits empty labeled Terraform blocks", () => {
    const base = raw(shared);
    delete base.outputs;
    const files = terraform(resolveStack(base));
    expect(parsed(files, "variables.tf.json")).not.toHaveProperty("variable");
    expect(parsed(files, "outputs.tf.json")).not.toHaveProperty("output");
  });
  it.each([
    ["shared", shared],
    ["per-topic", perTopic],
    ["dynamodb-archive", archiveExample],
  ] as const)("renders the full %s stack deterministically", (_name, stack) => {
    const files = terraform(stack);
    expect(terraform(stack)).toEqual(files);
    expect(files).toMatchSnapshot();
    for (const content of Object.values(files)) {
      const object = JSON.parse(content);
      expect(object["//"]).toContain(stack.name);
      expect(containsLocalPath(content, process.cwd())).toBe(false);
    }
  });
  it("passes a custom store index-shard count to the module", () => {
    const base = raw(shared);
    base.store = { ...base.store, config: { indexShards: 2 } };
    const files = terraform(resolveStack(base));
    expect(parsed(files, "main.tf.json")).toMatchObject({
      module: { store: { index_shards: 2 } },
    });
  });
  it("explains standalone has no Terraform", () => {
    expect(generate(local, options)).toEqual({
      kind: "not-applicable",
      reason: expect.stringContaining("no Terraform"),
    });
  });
  it("resolves module paths without consulting the working directory", () => {
    expect(
      relativeModuleSource(
        "infra/generated/stack",
        "infra/modules",
        "aws",
        "sqs",
      ),
    ).toBe("../../modules/aws/sqs");
    expect(
      relativeModuleSource("/repo/out", "/repo/infra/modules", "aws", "s3"),
    ).toBe("../infra/modules/aws/s3");
    expect(relativeModuleSource(".", ".modules", "aws", "s3")).toBe(
      "./.modules/aws/s3",
    );
    expect(() =>
      relativeModuleSource("/repo/out", "infra/modules", "aws", "s3"),
    ).toThrow("same path root");
  });
  it("computes relative, vendored and remote module sources", () => {
    const relative = { mode: "relative" } as const;
    expect(
      moduleSource("infra/generated/s", "infra/modules", relative, "aws", "s3"),
    ).toBe("../../modules/aws/s3");
    expect(
      moduleSource("out", "ignored", { mode: "vendor" }, "aws", "s3"),
    ).toBe("./modules/aws/s3");
    const remote = (base: string, version = "1.2.3") =>
      moduleSource(
        "out",
        "ignored",
        { mode: "remote", base, version },
        "aws",
        "sqs",
      );
    expect(
      remote("git::https://example.com/org/errtraq.git//infra/modules"),
    ).toBe(
      "git::https://example.com/org/errtraq.git//infra/modules/aws/sqs?ref=v1.2.3",
    );
    expect(remote("github.com/org/errtraq//infra/modules/", "1.0.0-rc.1")).toBe(
      "github.com/org/errtraq//infra/modules/aws/sqs?ref=v1.0.0-rc.1",
    );
    for (const base of [
      "../modules",
      "./infra/modules",
      "/abs/modules",
      "file:///abs/modules",
      "git::https://example.com/a/b.git//x?ref=main",
      "https://example.com/../x",
      "",
    ])
      expect(() => remote(base)).toThrow("Module base");
    expect(() => remote("github.com/o/r//m", "main")).toThrow("semantic");
  });
  it("renders vendored and remote sources into main.tf.json", () => {
    const render = (moduleSource: GenerateOptions["moduleSource"]) => {
      const result = generate(shared, { ...options, moduleSource });
      if (result.kind !== "terraform") throw new Error("expected terraform");
      return JSON.parse(result.files["main.tf.json"] ?? "{}").module as Record<
        string,
        { source: string }
      >;
    };
    const vendored = render({ mode: "vendor" });
    expect(Object.values(vendored).map((m) => m.source)).toSatisfy(
      (sources: string[]) =>
        sources.length > 0 &&
        sources.every((s) => s.startsWith("./modules/aws/")),
    );
    const remote = render({
      mode: "remote",
      base: "git::https://example.com/o/r.git//infra/modules",
      version: "0.1.0",
    });
    expect(
      Object.values(remote).every((m) => m.source.endsWith("?ref=v0.1.0")),
    ).toBe(true);
  });
  it("renders qualified, keyed, stack and artifact references", () => {
    expect(
      renderInfraValue(
        out("queues", "ingest", "arn"),
        "queue",
        perTopic,
        options,
      ),
    ).toBe(["$", '{module.queue.queues["ingest"]["arn"]}'].join(""));
    expect(
      renderInfraValue(output("blob", "bucket_name"), "store", shared, options),
    ).toBe(["$", "{module.blob.bucket_name}"].join(""));
    expect(renderInfraValue(stackValue("name"), "store", shared, options)).toBe(
      "aws-dynamodb",
    );
    expect(
      renderInfraValue(stackValue("protection"), "store", shared, options),
    ).toBe("production");
    expect(
      renderInfraValue(stackValue("region"), "store", shared, options),
    ).toBe("us-east-1");
    expect(
      renderInfraValue(stackValue("tags"), "store", shared, options),
    ).toEqual({ app: "errtraq" });
    expect(
      renderInfraValue(artifact("ingest"), "platform", shared, options),
    ).toBe("build/ingest.zip");
    expect(() =>
      renderInfraValue(artifact("missing"), "platform", shared, options),
    ).toThrow("Missing artifact path");
    expect(() =>
      renderInfraValue(env("RUNTIME"), "store", shared, options),
    ).toThrow("Runtime environment");
  });
  it("escapes literal values and object keys without escaping generated expressions", () => {
    const literal = ["$", "{aws:username}"].join("");
    expect(
      renderInfraValue(
        {
          [literal]: `x ${literal} %{ if }`,
          reference: output("blob", "bucket_name"),
        },
        "store",
        shared,
        options,
      ),
    ).toEqual({
      [["$$", "{aws:username}"].join("")]: `x $${literal} %%{ if }`,
      reference: ["$", "{module.blob.bucket_name}"].join(""),
    });
  });
  it("uses generation environment values only for backend references", () => {
    const base = raw(shared);
    base.backend = {
      type: "s3",
      config: { bucket: generationEnv("STATE_BUCKET"), key: "state.tfstate" },
    };
    const resolved = resolveStack(base);
    expect(() => terraform(resolved)).toThrow(
      "Missing generation environment STATE_BUCKET",
    );
    const marker = ["$", "{literal}"].join("");
    const files = terraform(resolved, {
      ...options,
      generationEnv: { STATE_BUCKET: `bucket-${marker}` },
    });
    expect(parsed(files, "backend.tf.json")).toMatchObject({
      terraform: {
        backend: { s3: { bucket: `bucket-$${marker}`, key: "state.tfstate" } },
      },
    });
  });
  it("renders JSON variables with jsondecode and emits only non-sensitive defaults", () => {
    const base = raw(shared);
    const canary = "SENSITIVE-VALUE-MUST-NOT-BE-EMITTED";
    base.variables = {
      DOC: {
        type: "json",
        sensitive: false,
        default: { z: [1, "two"], a: "text" },
      },
      TEXT: {
        type: "string",
        sensitive: false,
        default: ["$", "{literal}"].join(""),
      },
      SECRET: { type: "string", sensitive: true },
    };
    const original = base.store;
    base.store = {
      ...original,
      infra: {
        ...original.infra,
        module: { ...original.infra.module, sensitiveInputs: ["credential"] },
        inputs: (config, view) => ({
          ...original.infra.inputs(config, view),
          document: variable("DOC"),
          credential: variable("SECRET"),
        }),
      },
    };
    const files = terraform(resolveStack(base), {
      ...options,
      generationEnv: { SECRET: canary },
    });
    expect(Object.values(files).join("\n")).not.toContain(canary);
    const variables = parsed(files, "variables.tf.json");
    expect(variables).toMatchObject({
      variable: {
        DOC: { type: "string", default: '{"a":"text","z":[1,"two"]}' },
        SECRET: { type: "string", sensitive: true },
      },
    });
    expect(files["variables.tf.json"]).toContain("jsondecode(var.DOC)");
    expect(files["main.tf.json"]).toContain(
      ["$", "{jsondecode(var.DOC)}"].join(""),
    );
    expect(parsed(files, "terraform.tfvars.json")).toMatchObject({
      DOC: '{"a":"text","z":[1,"two"]}',
      TEXT: ["$", "{literal}"].join(""),
    });
    expect(files["terraform.tfvars.json"]).not.toContain("SECRET");
  });
  it("substitutes existing keyed queue outputs without emitting its module", () => {
    const base = raw(shared);
    const policy = '{"Version":"2012-10-17","Statement":[]}';
    base.queue = {
      ...base.queue,
      existing: {
        queues: {
          shared: { arn: "arn:existing", url: "https://existing" },
          record: { arn: "arn:record", url: "https://record" },
        },
        policies: {
          produce: { shared: policy, record: policy },
          consume: { shared: policy, record: policy },
        },
      },
    };
    const files = terraform(resolveStack(base));
    const main = parsed(files, "main.tf.json");
    expect(main).toMatchObject({
      module: {
        platform: { queue_triggers: { shared: { resource: "arn:existing" } } },
      },
    });
    expect(files["main.tf.json"]).toContain("https://existing");
    expect(files["main.tf.json"]).not.toContain("module.queue.");
    expect(main.module).not.toHaveProperty("queue");
  });
  it("resolves existing output aliases and non-sensitive variables recursively", () => {
    const base = raw(shared);
    base.variables = { QUEUE_URL: { type: "string", sensitive: false } };
    const policy = '{"Version":"2012-10-17","Statement":[]}';
    base.queue = {
      ...base.queue,
      existing: {
        queues: {
          shared: {
            arn: output("blob", "bucket_arn"),
            url: variable("QUEUE_URL"),
          },
          record: { arn: "arn:record", url: "https://record" },
        },
        policies: {
          produce: { shared: policy, record: policy },
          consume: { shared: policy, record: policy },
        },
      },
    };
    const files = terraform(resolveStack(base));
    const main = parsed(files, "main.tf.json");
    expect(main).toMatchObject({
      module: {
        platform: {
          queue_triggers: {
            shared: { resource: ["$", "{module.blob.bucket_arn}"].join("") },
          },
        },
      },
    });
    expect(files["main.tf.json"]).toContain(["$", "{var.QUEUE_URL}"].join(""));
    expect(main.module).not.toHaveProperty("queue");
  });
  it("escapes provider values and resolves explicitly qualified providers", () => {
    const base = raw(shared);
    const literal = ["$", "{var.user}"].join("");
    base.providers = {
      ...base.providers,
      aws_eu: {
        source: "hashicorp/aws",
        version: ">= 6.32.1, < 7.0",
        region: "eu-west-1",
        tags: { note: literal },
      },
    };
    const resolved = resolveStack(base);
    expect(
      renderInfraValue(
        stackValue("region", "aws_eu"),
        "store",
        resolved,
        options,
      ),
    ).toBe("eu-west-1");
    expect(
      renderInfraValue(
        stackValue("tags", "aws_eu"),
        "store",
        resolved,
        options,
      ),
    ).toEqual({ note: `$${literal}` });
    expect(terraform(resolved)["providers.tf.json"]).toContain(`$${literal}`);
  });
  it("rejects Terraform module metadata collisions and missing artifacts", () => {
    const base = raw(shared);
    const original = base.store;
    base.store = {
      ...original,
      infra: { ...original.infra, inputs: () => ({ source: "override" }) },
    };
    expect(() => terraform(resolveStack(base))).toThrow(
      "conflicts with Terraform metadata",
    );
    expect(() => terraform(shared, { ...options, artifactPaths: {} })).toThrow(
      "Missing artifact path",
    );
  });
  it("uses aliases and nested selection module addresses", () => {
    const base = raw(shared);
    base.providers = {
      ...base.providers,
      aws_eu: {
        source: "hashicorp/aws",
        version: ">= 6.32.1, < 7.0",
        region: "eu-west-1",
        tags: { team: "eu" },
      },
    };
    const child = {
      ...base.store,
      manifest: { ...base.store.manifest, kind: "catalog" as const },
      infra: {
        ...base.store.infra,
        bindings: [],
        capabilities: {},
        resources: {},
        inputs: () => ({ name: stackValue("name") }),
      },
    };
    base.store = {
      ...base.store,
      provider: "aws_eu",
      manifest: { ...base.store.manifest, childKinds: { catalog: "catalog" } },
      children: { catalog: child },
    };
    const files = terraform(resolveStack(base));
    expect(parsed(files, "main.tf.json")).toMatchObject({
      module: {
        store: { providers: { aws: "aws.aws_eu" }, tags: { team: "eu" } },
        store_catalog: { source: "../../modules/aws/dynamodb" },
      },
    });
    expect(parsed(files, "providers.tf.json")).toMatchObject({
      provider: {
        aws: [
          { region: "us-east-1" },
          { alias: "aws_eu", region: "eu-west-1" },
        ],
      },
      terraform: {
        required_providers: {
          aws: { source: "hashicorp/aws", version: ">= 6.32.1, < 7.0" },
        },
      },
    });
  });
});
