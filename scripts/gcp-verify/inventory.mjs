import { fileURLToPath } from "node:url";
import { main, ok } from "./lib.mjs";

/**
 * Lists the errtraq-named resources left in the project, for the post-destroy check
 * (`--expect empty`, the default) or a mid-run overview (`--expect present`). Resources Terraform
 * owns must be gone after a destroy; resources outside its state (the bootstrap secret, container
 * images, enabled APIs, a soft-deleted Firestore database id) are listed as expected leftovers
 * for the operator to remove or accept.
 */
export const probe = {
  name: "inventory",
  description: "errtraq-named resources left in the project",
  run,
};

const short = (name) =>
  String(name ?? "")
    .split("/")
    .pop();

/** Each category: how to list, which names are the stack's, and whether Terraform owns it. */
export function categories(ctx) {
  const { project, region, stack, bootstrapSecret, repository } = ctx.config;
  const mine = (name) => short(name).startsWith(`${stack}-`);
  const roleStem = `${stack.replaceAll("-", "_")}_`;
  return [
    {
      id: "Cloud Run services",
      owned: true,
      url: `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services`,
      key: "services",
      pick: mine,
    },
    {
      id: "Pub/Sub topics",
      owned: true,
      url: `https://pubsub.googleapis.com/v1/projects/${project}/topics`,
      key: "topics",
      pick: mine,
    },
    {
      id: "Pub/Sub subscriptions",
      owned: true,
      url: `https://pubsub.googleapis.com/v1/projects/${project}/subscriptions`,
      key: "subscriptions",
      pick: mine,
    },
    {
      id: "GCS buckets",
      owned: true,
      url: `https://storage.googleapis.com/storage/v1/b?project=${project}&prefix=${stack}-`,
      key: "items",
      pick: mine,
    },
    {
      id: "Firestore databases",
      owned: true,
      url: `https://firestore.googleapis.com/v1/projects/${project}/databases`,
      key: "databases",
      pick: mine,
    },
    {
      id: "Scheduler jobs",
      owned: true,
      url: `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/${region}/jobs`,
      key: "jobs",
      pick: mine,
    },
    {
      id: "Service accounts",
      owned: true,
      url: `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`,
      key: "accounts",
      pick: (_, item) =>
        mine(String(item.email ?? "").split("@")[0] ?? "") ||
        /^errtraq-(push|scheduler)@/.test(String(item.email ?? "")),
      label: (item) => String(item.email ?? "").split("@")[0],
    },
    {
      id: "Custom roles (including soft-deleted)",
      owned: true,
      url: `https://iam.googleapis.com/v1/projects/${project}/roles?showDeleted=true&view=BASIC`,
      key: "roles",
      pick: (name, item) => short(name).startsWith(roleStem) && !item.deleted,
      note: "soft-deleted roles are listed separately below",
    },
    {
      id: "Bootstrap and errtraq secrets (outside Terraform)",
      owned: false,
      url: `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`,
      key: "secrets",
      pick: (name) =>
        short(name) === bootstrapSecret || short(name).startsWith("errtraq-"),
    },
    ...(repository
      ? [
          {
            id: "Artifact Registry images (outside Terraform)",
            owned: false,
            url: `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${region}/repositories/${repository}/dockerImages`,
            key: "dockerImages",
            pick: () => true,
            label: (item) => `${short(item.name).split("@")[0]}`,
          },
        ]
      : []),
  ];
}

async function listAll(ctx, category) {
  const items = [];
  let token = "";
  for (let page = 0; page < 20; page++) {
    const url = `${category.url}${category.url.includes("?") ? "&" : "?"}${token ? `pageToken=${encodeURIComponent(token)}&` : ""}pageSize=500`;
    const response = await ctx.http("GET", url);
    if (!ok(response)) return { error: response.status };
    items.push(...(response.json?.[category.key] ?? []));
    token = response.json?.nextPageToken ?? "";
    if (!token) break;
  }
  return { items };
}

/** Returns `{ owned, outside }` counts; also prints one line per category. */
export async function inventory(ctx) {
  const expect = ctx.flags.expect === "present" ? "present" : "empty";
  let owned = 0;
  let outside = 0;
  for (const category of categories(ctx)) {
    const listed = await listAll(ctx, category);
    if (listed.error) {
      ctx.report.fail(category.id, `cannot list (${listed.error})`);
      continue;
    }
    const names = listed.items
      .filter((item) => category.pick(item.name ?? item.id ?? "", item))
      .map((item) =>
        category.label ? category.label(item) : short(item.name ?? item.id),
      );
    if (category.owned) owned += names.length;
    else outside += names.length;
    const listing = names.length
      ? ` (${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""})`
      : "";
    if (category.owned && expect === "empty")
      ctx.report.check(
        category.id,
        names.length === 0,
        `${names.length} left${listing}`,
      );
    else ctx.report.info(category.id, `${names.length}${listing}`);
  }
  // Soft-deleted custom roles stay for a while and block reuse of the id until undeleted or purged.
  const roles = await listAll(ctx, {
    url: `https://iam.googleapis.com/v1/projects/${ctx.config.project}/roles?showDeleted=true&view=BASIC`,
    key: "roles",
  });
  const deleted = (roles.items ?? []).filter(
    (item) =>
      item.deleted &&
      short(item.name).startsWith(`${ctx.config.stack.replaceAll("-", "_")}_`),
  );
  ctx.report.info(
    "Soft-deleted custom roles",
    `${deleted.length}; the provider undeletes them on the next apply with the same ids`,
  );
  const enabled = await listAll(ctx, {
    url: `https://serviceusage.googleapis.com/v1/projects/${ctx.config.project}/services?filter=state:ENABLED`,
    key: "services",
  });
  ctx.report.info(
    "Enabled APIs left on",
    `${(enabled.items ?? []).length} (disable the ones the run enabled if the project is shared)`,
  );
  return { owned, outside };
}

async function run(ctx) {
  await inventory(ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
