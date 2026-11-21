import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadGaps() {
  const gaps = JSON.parse(
    readFileSync(new URL("./gaps.json", import.meta.url), "utf8"),
  );
  const doc = readFileSync(resolve(".agents-docs/WINTERBAUME_GAPS.md"), "utf8");
  const expected = [
    "s3-lifecycle",
    "s3-ownership-delete",
    "lambda-partial-batch",
    "eventbridge-retry-dlq",
    "dynamodb-deletion-protection",
    "dynamodb-sse",
    "tags-dynamodb",
    "tags-iam",
    "tags-s3",
    "tags-lambda-mapping",
    "lambda-vpc-readback",
  ];
  if (
    JSON.stringify(Object.keys(gaps).sort()) !== JSON.stringify(expected.sort())
  )
    throw new Error("Unexpected emulator exception inventory");
  for (const [id, gap] of Object.entries(gaps))
    if (
      !doc.includes(`## ${gap.heading}\n`) ||
      !gap.effect ||
      !(
        gap.issue === null ||
        /^https:\/\/github\.com\/moriyoshi\/winterbaume\/issues\/\d+$/.test(
          gap.issue,
        )
      )
    )
      throw new Error(`Missing documentation for emulator exception ${id}`);
  return gaps;
}
export function skipped(gaps, id) {
  if (!gaps[id]) throw new Error(`Undeclared emulator exception ${id}`);
  console.log(
    `SKIPPED (winterbaume gap: ${id}): ${gaps[id].effect} (${gaps[id].issue ?? "upstream issue not filed"})`,
  );
}
