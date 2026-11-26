import { deriveDeployment, validateStack } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { generate } from "../packages/infra-gen/src/index.js";
import stack from "./aws-dynamodb-ui.js";

const artifactPaths = {
  ingest: "../../dist/aws-dynamodb-ui/ingest/bundle.zip",
  api: "../../dist/aws-dynamodb-ui/api/bundle.zip",
  consumer: "../../dist/aws-dynamodb-ui/consumer/bundle.zip",
  record: "../../dist/aws-dynamodb-ui/record/bundle.zip",
  cron: "../../dist/aws-dynamodb-ui/cron/bundle.zip",
};
describe("aws-dynamodb-ui", () => {
  it("validates and keeps ingest on its own function URL", () => {
    expect(validateStack(stack)).toEqual([]);
    const view = deriveDeployment(stack);
    const api = view.functions.find((fn) => fn.http.includes("api"));
    expect(api?.http).toEqual(["api"]);
    expect(
      view.functions.find((fn) => fn.http.includes("ingest"))?.id,
    ).not.toBe(api?.id);
    expect(stack.platform.infra.module.outputs).toMatchObject({
      ui_domain_name: "string",
      ui_distribution_id: "string",
      ui_bucket_name: "string",
    });
  });
  it("passes the UI to the platform module and surfaces its outputs", () => {
    const result = generate(stack, {
      outputDirectory: "infra/generated/aws-dynamodb-ui",
      modulesDirectory: "infra/modules",
      generationEnv: {},
      artifactPaths,
    });
    if (result.kind !== "terraform") throw new Error("expected terraform");
    const main = JSON.parse(result.files["main.tf.json"] ?? "{}");
    expect(main.module.platform.ui).toEqual({
      build_anchor: artifactPaths.api,
      price_class: "PriceClass_100",
    });
    expect(main.module.platform.ingest_public_url).toBe(
      ["$", "{var.ingest_public_url}"].join(""),
    );
    // The UI source directory is a build input only: it never appears in the Terraform.
    expect(result.files["main.tf.json"]).not.toContain("packages/ui");
    expect(result.files["main.tf.json"]).toMatchSnapshot("main");
    expect(result.files["outputs.tf.json"]).toMatchSnapshot("outputs");
    const outputs = JSON.parse(result.files["outputs.tf.json"] ?? "{}");
    expect(Object.keys(outputs.output).sort()).toEqual([
      "api_url",
      "ingest_url",
      "ui_bucket_name",
      "ui_distribution_id",
      "ui_domain_name",
    ]);
  });
});
