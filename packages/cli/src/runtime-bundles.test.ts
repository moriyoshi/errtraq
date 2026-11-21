import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe.each(["blob-s3", "queue-sqs", "kv-dynamodb"])(
  "%s runtime bundle",
  (adapter) => {
    it("excludes the stack schema and zod", async () => {
      const result = await build({
        entryPoints: [`packages/adapters/${adapter}/src/runtime.ts`],
        bundle: true,
        platform: "browser",
        format: "esm",
        conditions: ["development"],
        write: false,
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs).join("\n");
      expect(inputs).not.toContain(`packages/adapters/${adapter}/src/stack.ts`);
      expect(inputs).not.toMatch(/node_modules\/.*zod\//);
    });
  },
);
