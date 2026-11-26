import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, ok } from "./lib.mjs";

/**
 * IAM on a real project. Policy checks read the live IAM policies (no primitive roles on the
 * errtraq accounts, conditions as designed, the invoker check skipped (`invokerIamDisabled`) only on
 * ingest and API and no `allUsers` invoker anywhere, nothing public on
 * the bucket or topics). Effective-permission checks impersonate each function service account
 * (the operator needs `roles/iam.serviceAccountTokenCreator` on them) and ask `testIamPermissions`
 * on its resources, comparing with the permissions the roles in the Terraform state grant it:
 * what it must have is granted, what it must not have is denied. Firestore, whose roles are
 * conditioned on the database name, is checked with real reads and writes instead.
 */
export const probe = {
  name: "iam",
  description:
    "live IAM policies, then effective permissions of each function service account",
  run,
};

export const FUNCTIONS = [
  "ingest",
  "api",
  "consumer",
  "record",
  "cron",
  "bootstrap",
];
const PRIMITIVE = new Set(["roles/owner", "roles/editor", "roles/viewer"]);
const BUCKET_TESTS = [
  "storage.objects.get",
  "storage.objects.list",
  "storage.objects.create",
  "storage.objects.delete",
  "storage.objects.update",
  "storage.buckets.get",
  "storage.buckets.delete",
  "storage.buckets.setIamPolicy",
];
const TOPIC_TESTS = [
  "pubsub.topics.publish",
  "pubsub.topics.get",
  "pubsub.topics.delete",
  "pubsub.topics.setIamPolicy",
  // Valid on a topic (subscriptions.consume is not: the whole test is refused with 400).
  "pubsub.topics.attachSubscription",
];
const SECRET_TESTS = [
  "secretmanager.versions.access",
  "secretmanager.versions.add",
  "secretmanager.secrets.get",
  "secretmanager.secrets.delete",
  "secretmanager.secrets.setIamPolicy",
];
const PROJECT_TESTS = [
  "resourcemanager.projects.setIamPolicy",
  "iam.roles.create",
  "iam.serviceAccounts.create",
  "iam.serviceAccountKeys.create",
  "run.services.create",
  "storage.buckets.create",
  "pubsub.topics.create",
  "secretmanager.secrets.delete",
];

/** Roles, bindings and service account emails out of `terraform show -json`. */
export function parseState(state) {
  const roles = new Map();
  const bindings = [];
  const walk = (module) => {
    for (const resource of module?.resources ?? []) {
      const v = resource.values ?? {};
      if (resource.type === "google_project_iam_custom_role")
        roles.set(
          v.name ?? `projects/${v.project}/roles/${v.role_id}`,
          v.permissions ?? [],
        );
      else if (resource.type === "google_project_iam_member")
        bindings.push({
          member: v.member,
          kind: "project",
          role: v.role,
          resource: v.project,
          expression: v.condition?.[0]?.expression ?? "",
        });
      else if (resource.type === "google_storage_bucket_iam_member")
        bindings.push({
          member: v.member,
          kind: "bucket",
          role: v.role,
          resource: v.bucket,
          expression: "",
        });
      else if (resource.type === "google_pubsub_topic_iam_member")
        bindings.push({
          member: v.member,
          kind: "topic",
          role: v.role,
          resource: v.topic,
          expression: "",
        });
      else if (resource.type === "google_secret_manager_secret_iam_member")
        bindings.push({
          member: v.member,
          kind: "secret",
          role: v.role,
          resource: v.secret_id,
          expression: "",
        });
    }
    for (const child of module?.child_modules ?? []) walk(child);
  };
  walk(state?.values?.root_module);
  return { roles, bindings };
}

/** Permissions a member holds on one resource, from the state's bindings (predefined roles through `lookup`). */
export async function grantedOn(parsed, member, kind, matches, lookup) {
  const granted = new Set();
  for (const binding of parsed.bindings) {
    if (binding.member !== member || binding.kind !== kind || !matches(binding))
      continue;
    const permissions =
      parsed.roles.get(binding.role) ?? (await lookup(binding.role));
    for (const permission of permissions) granted.add(permission);
  }
  return granted;
}

/** Tested permissions that are wrongly missing or wrongly present. */
export function diffPermissions(tested, granted, expected) {
  const allowed = new Set(granted);
  return {
    missing: tested.filter(
      (permission) => expected.has(permission) && !allowed.has(permission),
    ),
    excess: tested.filter(
      (permission) => !expected.has(permission) && allowed.has(permission),
    ),
  };
}

// Resource Manager reads a policy with POST; Cloud Run v2 and Pub/Sub with GET (POST is a 404).
const iamPolicy = (ctx, url, body) =>
  url.startsWith("https://cloudresourcemanager.")
    ? ctx.http("POST", url, { json: body ?? {} })
    : ctx.http("GET", url);

/** Live policy checks. */
export async function policyChecks(ctx) {
  const { report, names, config } = ctx;
  const accounts = new Map([
    ...FUNCTIONS.map((fn) => [names.serviceAccount(fn), fn]),
    [names.pushServiceAccount, "push"],
    [names.schedulerServiceAccount, "scheduler"],
  ]);
  const project = await iamPolicy(
    ctx,
    `https://cloudresourcemanager.googleapis.com/v1/projects/${config.project}:getIamPolicy`,
    { options: { requestedPolicyVersion: 3 } },
  );
  if (
    !report.check(
      "project IAM policy readable",
      ok(project),
      `status ${project.status}`,
    )
  )
    return;
  const bindings = project.json.bindings ?? [];
  const own = bindings.filter((binding) =>
    (binding.members ?? []).some((member) =>
      accounts.has(member.replace("serviceAccount:", "")),
    ),
  );
  const primitive = own.filter((binding) => PRIMITIVE.has(binding.role));
  report.check(
    "no errtraq service account holds a primitive role",
    primitive.length === 0,
    () => `${primitive.length} binding(s)`,
  );
  const rolePrefix = `projects/${config.project}/roles/${names.rolePrefix}_`;
  const stray = own.filter((binding) => !binding.role.startsWith(rolePrefix));
  report.check(
    "project-level bindings of errtraq accounts use only the stack's custom roles",
    stray.length === 0,
    () =>
      `unexpected roles: ${stray.map((binding) => binding.role).join(", ")}`,
  );
  const conditional = own.filter(
    (binding) =>
      /_fs_(store|kv)_/.test(binding.role) ||
      /_bootstrap_secret$/.test(binding.role),
  );
  const wrong = conditional.filter((binding) => {
    const expression = binding.condition?.expression ?? "";
    if (/_fs_store_/.test(binding.role))
      return expression !== `resource.name == "${names.database("store")}"`;
    if (/_fs_kv_/.test(binding.role))
      return expression !== `resource.name == "${names.database("kv")}"`;
    return !expression.includes(`/secrets/${config.bootstrapSecret}`);
  });
  report.check(
    "Firestore and bootstrap-secret roles carry the designed conditions",
    conditional.length > 0 && wrong.length === 0,
    () =>
      `${conditional.length} bindings, ${wrong.length} with another condition`,
  );

  const operators = new Set(
    String(ctx.flags.operator ?? ctx.env.ERRTRAQ_GCP_OPERATOR_MEMBER ?? "")
      .split(",")
      .filter(Boolean),
  );
  for (const fn of FUNCTIONS) {
    const response = await iamPolicy(
      ctx,
      `https://run.googleapis.com/v2/${names.service(fn)}:getIamPolicy`,
    );
    if (response.status === 404) {
      report.skip(`service ${fn} invokers`, "the stack has no such service");
      continue;
    }
    const invokers = (response.json?.bindings ?? [])
      .filter((binding) => binding.role === "roles/run.invoker")
      .flatMap((binding) => binding.members ?? []);
    const open = fn === "ingest" || fn === "api";
    const service = await ctx.http(
      "GET",
      `https://run.googleapis.com/v2/${names.service(fn)}`,
    );
    report.check(
      `service ${fn} ${open ? "skips" : "enforces"} the invoker check`,
      ok(service) && Boolean(service.json?.invokerIamDisabled) === open,
      `status ${service.status}`,
    );
    const expected = open
      ? []
      : fn === "consumer" || fn === "record"
        ? [`serviceAccount:${names.pushServiceAccount}`]
        : fn === "cron"
          ? [`serviceAccount:${names.schedulerServiceAccount}`]
          : [...operators];
    const exact =
      invokers.length === expected.length &&
      expected.every((member) => invokers.includes(member));
    report.check(
      `service ${fn} invokers are exactly as designed`,
      ok(response) && (fn !== "bootstrap" || operators.size > 0) && exact,
      () =>
        `${invokers.length} invoker(s), ${fn === "bootstrap" && operators.size === 0 ? "pass --operator <member> to compare" : "differs"}`,
    );
  }
  const bucket = await ctx.http(
    "GET",
    `https://storage.googleapis.com/storage/v1/b/${names.bucket}/iam`,
  );
  const publicBucket = (bucket.json?.bindings ?? []).filter((binding) =>
    (binding.members ?? []).some(
      (member) => member === "allUsers" || member === "allAuthenticatedUsers",
    ),
  );
  report.check(
    "the bucket grants nothing to the public",
    ok(bucket) && publicBucket.length === 0,
    `status ${bucket.status}`,
  );
  for (const physical of ["shared", "record"]) {
    const topic = await iamPolicy(
      ctx,
      `https://pubsub.googleapis.com/v1/${names.topic(physical)}:getIamPolicy`,
    );
    if (topic.status === 404) continue;
    const open = (topic.json?.bindings ?? []).some((binding) =>
      (binding.members ?? []).some(
        (member) => member === "allUsers" || member === "allAuthenticatedUsers",
      ),
    );
    report.check(
      `topic ${physical} grants nothing to the public`,
      ok(topic) && !open,
      `status ${topic.status}`,
    );
  }
}

async function testPermissions(ctx, token, url, permissions, method = "POST") {
  const response =
    method === "GET"
      ? await ctx.http(
          "GET",
          `${url}?${permissions.map((item) => `permissions=${item}`).join("&")}`,
          { token },
        )
      : await ctx.http("POST", url, { token, json: { permissions } });
  return ok(response) ? new Set(response.json?.permissions ?? []) : undefined;
}

async function firestoreAccess(ctx, token, purpose, fn, probeId) {
  const base = `https://firestore.googleapis.com/v1/${ctx.names.database(purpose)}/documents`;
  const read = await ctx.http(
    "GET",
    `${base}/${purpose === "kv" ? "kv/g8-iam-probe" : "meta/schema"}`,
    { token },
  );
  const write = await ctx.http(
    "PATCH",
    `${base}/g8probe/${probeId}-${fn}?currentDocument.exists=false`,
    { token, json: { fields: { v: { stringValue: "x" } } } },
  );
  return {
    read: read.status !== 403 && read.status !== 401,
    write: ok(write),
    path: `g8probe/${probeId}-${fn}`,
  };
}

/** Effective permissions of each function account against the Terraform state. */
export async function effectiveChecks(ctx) {
  const { report, names, config } = ctx;
  if (!config.statePath)
    return report.skip(
      "effective permissions",
      "pass --state <terraform show -json output> to derive what each account must and must not have",
    );
  const parsed = parseState(
    JSON.parse(
      await (ctx.deps.readFile ?? ((path) => readFile(resolve(path), "utf8")))(
        config.statePath,
      ),
    ),
  );
  const roleCache = new Map();
  const lookup = async (role) => {
    if (!roleCache.has(role)) {
      const response = await ctx.http(
        "GET",
        `https://iam.googleapis.com/v1/${role}`,
      );
      roleCache.set(role, response.json?.includedPermissions ?? []);
    }
    return roleCache.get(role);
  };
  const probeId = randomUUID().slice(0, 8);
  const accounts = [...FUNCTIONS.map((fn) => [fn, names.serviceAccount(fn)])];
  const written = [];
  for (const [fn, email] of accounts) {
    const exists = await ctx.http(
      "GET",
      `https://run.googleapis.com/v2/${names.service(fn)}`,
    );
    if (exists.status === 404) continue;
    let token;
    try {
      token = await ctx.auth.impersonatedAccessToken(email);
    } catch (error) {
      report.skip(
        `${fn} effective permissions`,
        error instanceof Error ? error.message : "cannot impersonate",
      );
      continue;
    }
    const member = `serviceAccount:${email}`;
    const problems = [];
    const check = async (label, tested, url, kind, matches, method) => {
      const granted = await testPermissions(ctx, token, url, tested, method);
      if (!granted) return problems.push(`${label}: test refused`);
      const expected = await grantedOn(parsed, member, kind, matches, lookup);
      const { missing, excess } = diffPermissions(tested, granted, expected);
      if (missing.length)
        problems.push(`${label} missing ${missing.join(" ")}`);
      if (excess.length) problems.push(`${label} excess ${excess.join(" ")}`);
    };
    await check(
      "bucket",
      BUCKET_TESTS,
      `https://storage.googleapis.com/storage/v1/b/${names.bucket}/iam/testPermissions`,
      "bucket",
      () => true,
      "GET",
    );
    for (const physical of ["shared", "record"]) {
      if (
        (
          await ctx.http(
            "GET",
            `https://pubsub.googleapis.com/v1/${names.topic(physical)}`,
          )
        ).status === 404
      )
        continue;
      await check(
        `topic ${physical}`,
        TOPIC_TESTS,
        `https://pubsub.googleapis.com/v1/${names.topic(physical)}:testIamPermissions`,
        "topic",
        (binding) =>
          binding.resource.endsWith(names.topic(physical).split("/").pop()),
      );
    }
    await check(
      "bootstrap secret",
      SECRET_TESTS,
      `https://secretmanager.googleapis.com/v1/${names.secret}:testIamPermissions`,
      "project",
      (binding) =>
        binding.expression.includes(`/secrets/${config.bootstrapSecret}`),
    );
    await check(
      "project",
      PROJECT_TESTS,
      `https://cloudresourcemanager.googleapis.com/v1/projects/${config.project}:testIamPermissions`,
      "project",
      (binding) => binding.expression === "",
    );
    // Firestore: reads and writes through the real API, compared with the conditioned custom roles.
    for (const purpose of ["store", "kv"]) {
      const held = parsed.bindings.filter(
        (binding) =>
          binding.member === member &&
          binding.kind === "project" &&
          binding.role.includes(`_fs_${purpose}_`),
      );
      const canRead = held.some((binding) => binding.role.endsWith("_read"));
      const canWrite = held.some((binding) => binding.role.endsWith("_write"));
      const actual = await firestoreAccess(ctx, token, purpose, fn, probeId);
      if (actual.write) written.push({ purpose, path: actual.path });
      if (actual.read !== canRead)
        problems.push(
          `${purpose} database read ${actual.read ? "allowed" : "denied"}, expected ${canRead ? "allowed" : "denied"}`,
        );
      if (actual.write !== canWrite)
        problems.push(
          `${purpose} database write ${actual.write ? "allowed" : "denied"}, expected ${canWrite ? "allowed" : "denied"}`,
        );
    }
    report.check(
      `${fn} effective permissions match the granted roles (none extra, none missing)`,
      problems.length === 0,
      () => problems.join("; "),
    );
  }
  for (const { purpose, path } of written)
    await ctx.http(
      "DELETE",
      `https://firestore.googleapis.com/v1/${names.database(purpose)}/documents/${path}`,
      { raw: true },
    );
}

async function run(ctx) {
  await policyChecks(ctx);
  await effectiveChecks(ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
