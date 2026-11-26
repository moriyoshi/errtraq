import { describe, expect, it } from "vitest";
import {
  diffPermissions,
  effectiveChecks,
  grantedOn,
  parseState,
  policyChecks,
} from "./iam.mjs";
import { PROJECT, routerFetch, testContext } from "./testing.mjs";

const sa = (fn) =>
  `serviceAccount:gcp-g8-${fn}@${PROJECT}.iam.gserviceaccount.com`;
const push = `serviceAccount:errtraq-push@${PROJECT}.iam.gserviceaccount.com`;
const scheduler = `serviceAccount:errtraq-scheduler@${PROJECT}.iam.gserviceaccount.com`;
const role = (name) => `projects/${PROJECT}/roles/gcp_g8_${name}`;

const state = {
  values: {
    root_module: {
      child_modules: [
        {
          resources: [
            {
              type: "google_project_iam_custom_role",
              values: {
                name: role("blob_read"),
                permissions: ["storage.objects.get"],
              },
            },
            {
              type: "google_project_iam_custom_role",
              values: {
                name: role("fs_store_read"),
                permissions: ["datastore.entities.get"],
              },
            },
            {
              type: "google_storage_bucket_iam_member",
              values: {
                member: sa("api"),
                role: role("blob_read"),
                bucket: "b",
              },
            },
            {
              type: "google_project_iam_member",
              values: {
                member: sa("api"),
                role: role("fs_store_read"),
                project: PROJECT,
                condition: [
                  {
                    expression: `resource.name == "projects/${PROJECT}/databases/gcp-g8-store"`,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  },
};

describe("iam probe", () => {
  it("derives granted permissions from the state", async () => {
    const parsed = parseState(state);
    const granted = await grantedOn(
      parsed,
      sa("api"),
      "bucket",
      () => true,
      async () => [],
    );
    expect([...granted]).toEqual(["storage.objects.get"]);
    expect(
      diffPermissions(
        ["storage.objects.get", "storage.objects.delete"],
        new Set(["storage.objects.delete"]),
        granted,
      ),
    ).toEqual({
      missing: ["storage.objects.get"],
      excess: ["storage.objects.delete"],
    });
  });

  function policyFetch({ publicConsumer = false, extraRole = false } = {}) {
    const invokers = {
      ingest: [],
      api: [],
      consumer: publicConsumer ? ["allUsers"] : [push],
      record: [push],
      cron: [scheduler],
      bootstrap: ["user:op@example.com"],
    };
    return routerFetch([
      [
        "POST",
        /cloudresourcemanager.*getIamPolicy$/,
        () => ({
          body: {
            bindings: [
              {
                role: role("fs_store_read"),
                members: [sa("api")],
                condition: {
                  expression: `resource.name == "projects/${PROJECT}/databases/gcp-g8-store"`,
                },
              },
              ...(extraRole
                ? [{ role: "roles/editor", members: [sa("cron")] }]
                : []),
            ],
          },
        }),
      ],
      [
        "POST",
        /run\.googleapis\.com.*services\/gcp-g8-(\w+):getIamPolicy$/,
        (_u, _i, m) => ({
          body: {
            bindings: [{ role: "roles/run.invoker", members: invokers[m[1]] }],
          },
        }),
      ],
      [
        "GET",
        /run\.googleapis\.com\/v2\/.*services\/gcp-g8-(\w+)$/,
        (_u, _i, m) => ({
          body: {
            invokerIamDisabled:
              m[1] === "ingest" ||
              m[1] === "api" ||
              (publicConsumer && m[1] === "consumer"),
          },
        }),
      ],
      ["GET", /storage\/v1\/b\/.*\/iam$/, () => ({ body: { bindings: [] } })],
      ["POST", /pubsub.*:getIamPolicy$/, () => ({ body: {} })],
    ]);
  }
  it("accepts the designed policies and rejects a public consumer or a primitive role", async () => {
    const good = await testContext({
      fetch: policyFetch(),
      flags: { operator: "user:op@example.com" },
    });
    await policyChecks(good.ctx);
    expect(good.output()).not.toContain("FAIL");
    const bad = await testContext({
      fetch: policyFetch({ publicConsumer: true, extraRole: true }),
      flags: { operator: "user:op@example.com" },
    });
    await policyChecks(bad.ctx);
    expect(bad.output()).toContain("FAIL service consumer invokers");
    expect(bad.output()).toContain(
      "FAIL service consumer enforces the invoker check",
    );
    expect(bad.output()).toContain(
      "FAIL no errtraq service account holds a primitive role",
    );
  });

  it("compares effective permissions with the state and cleans up Firestore probes", async () => {
    const deleted = [];
    const make = (grantedBucket) =>
      routerFetch([
        [
          "GET",
          /run\.googleapis\.com\/v2\/.*services\/gcp-g8-(\w+)$/,
          (_u, _i, m) => (m[1] === "api" ? { body: {} } : { status: 404 }),
        ],
        [
          "GET",
          /storage\/v1\/b\/.*\/iam\/testPermissions/,
          () => ({ body: { permissions: grantedBucket } }),
        ],
        [
          "GET",
          /pubsub\.googleapis\.com\/v1\/projects\/.*topics/,
          () => ({ status: 404 }),
        ],
        ["POST", /secretmanager.*:testIamPermissions$/, () => ({ body: {} })],
        [
          "POST",
          /cloudresourcemanager.*:testIamPermissions$/,
          () => ({ body: {} }),
        ],
        [
          "GET",
          /databases\/gcp-g8-store\/documents\/meta\/schema$/,
          () => ({ status: 404 }),
        ],
        [
          "GET",
          /databases\/gcp-g8-kv\/documents\/kv\//,
          () => ({ status: 403 }),
        ],
        ["PATCH", /documents\/g8probe/, () => ({ status: 403 })],
        [
          "DELETE",
          /./,
          (url) => {
            deleted.push(url);
            return { status: 200 };
          },
        ],
      ]);
    const deps = { readFile: async () => JSON.stringify(state) };
    const good = await testContext({
      fetch: make(["storage.objects.get"]),
      flags: { state: "x.json" },
      deps,
    });
    await effectiveChecks(good.ctx);
    expect(good.output()).toContain("PASS api effective permissions match");
    const excess = await testContext({
      fetch: make(["storage.objects.get", "storage.objects.delete"]),
      flags: { state: "x.json" },
      deps,
    });
    await effectiveChecks(excess.ctx);
    expect(excess.output()).toContain("FAIL api effective permissions match");
    expect(excess.output()).toContain("excess storage.objects.delete");
    const none = await testContext({ fetch: make([]), deps });
    await effectiveChecks(none.ctx);
    expect(none.output()).toContain("SKIP effective permissions");
  });
});
