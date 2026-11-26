import { expect, type Page, test } from "@playwright/test";

const base = () => process.env.ERRTRAQ_UI_URL ?? "";
const token = () => process.env.ERRTRAQ_TOKEN ?? "";
const issuesUrl = /\/default\/default\/issues(\?.*)?$/;
const headers = () => ({
  authorization: `Bearer ${token()}`,
  "content-type": "application/json",
});

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base()}/api/0${path}`, {
    ...init,
    headers: headers(),
  });
  expect(
    response.ok,
    `${init.method ?? "GET"} ${path}: ${response.status}`,
  ).toBe(true);
  return response.json();
}

async function login(page: Page) {
  await page.goto(`${base()}/`);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("API token").fill(token());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(issuesUrl);
}

/** These tests change issue statuses; put every issue back so the other test file is unaffected. */
async function restoreIssues() {
  for (const status of ["resolved", "ignored"]) {
    const rows = (await api(
      `/projects/default/default/issues/?query=is:${status}`,
    )) as { id: string }[];
    if (rows.length)
      await api(
        `/projects/default/default/issues/?${rows.map((r) => `id=${r.id}`).join("&")}`,
        { method: "PUT", body: JSON.stringify({ status: "unresolved" }) },
      );
  }
}

test.beforeEach(async ({ page }) => {
  // The production CSP is active in preview: any violation fails the test.
  page.on("console", (message) => {
    expect(message.text()).not.toMatch(/Content Security Policy/i);
  });
  page.on("pageerror", (error) => {
    throw error;
  });
});
test.afterEach(restoreIssues);

test("bulk resolve of two issues, then unresolve them again", async ({
  page,
}) => {
  await login(page);
  const rows = page.locator(".issue-row");
  await expect(rows).toHaveCount(2);
  // No bar actions until something is selected.
  await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);
  await page.getByLabel("Select all 2 loaded").check();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByText("No unresolved issues.")).toBeVisible();
  await page.getByRole("tab", { name: "resolved", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByLabel("Select all 2 loaded").check();
  await page.getByRole("button", { name: "Unresolve" }).click();
  await expect(page.getByText("No resolved issues.")).toBeVisible();
  await page.getByRole("tab", { name: "unresolved", exact: true }).click();
  await expect(rows).toHaveCount(2);
});

test("keyboard: j and k move, x selects, r resolves, ? opens the help", async ({
  page,
}) => {
  await login(page);
  const rows = page.locator(".issue-row");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("j");
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(0)).not.toHaveAttribute("aria-current", "true");
  await page.keyboard.press("j"); // clamps at the last row
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("k");
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

  // x selects the focused row; typing in the search box does not trigger shortcuts.
  await page.keyboard.press("x");
  await expect(rows.nth(0).getByRole("checkbox")).toBeChecked();
  await expect(rows.nth(1).getByRole("checkbox")).not.toBeChecked();
  const search = page.getByLabel("Search issues");
  if (await search.count()) {
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await page.keyboard.type("jxr");
    await expect(search).toHaveValue("jxr");
    await expect(rows.nth(0).getByRole("checkbox")).toBeChecked();
    await search.blur();
  }
  // Modifier keys are not shortcuts.
  await rows.nth(0).focus();
  await page.keyboard.press("Control+r");
  await expect(rows).toHaveCount(2);

  // ? opens the help dialog; Escape closes it; nothing else fires while it is open.
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("r");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // r resolves the selection. Keys are ignored while the request is in flight (aria-busy).
  const bar = page.getByRole("group", { name: "Bulk actions" });
  await page.keyboard.press("r");
  await expect(rows).toHaveCount(1);
  await expect(bar).toHaveAttribute("aria-busy", "false");
  // With nothing selected, r acts on the focused row (the remaining one).
  await page.keyboard.press("j");
  await page.keyboard.press("i");
  await expect(page.getByText("No unresolved issues.")).toBeVisible();
  await page.getByRole("tab", { name: "ignored", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("j");
  await page.keyboard.press("u");
  await expect(page.getByText("No ignored issues.")).toBeVisible();
});

test("keyboard: Enter opens the issue, [ and ] move between events, r resolves it", async ({
  page,
}) => {
  await login(page);
  await page.getByLabel("Sort").selectOption("freq");
  const rows = page.locator(".issue-row");
  await expect(rows.first()).toContainText("checkout failed");
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/issues\/[^/?]+$/);
  await expect(page.locator(".issue-title-full")).toContainText(
    "checkout failed",
  );
  // The latest event has an older neighbour; [ goes there, ] comes back.
  await expect(page.getByRole("link", { name: "Older" })).toBeVisible();
  await page.keyboard.press("[");
  await expect(page).toHaveURL(/event=/);
  await page.keyboard.press("]");
  await expect(page.getByRole("link", { name: "Older" })).toBeVisible();
  await page.keyboard.press("r");
  await expect(page.locator(".issue-facts .status")).toHaveText("resolved");
  // The status shows the optimistic value at once; keys wait for the request (button enabled).
  await expect(page.getByRole("button", { name: "Unresolve" })).toBeEnabled();
  await page.keyboard.press("u");
  await expect(page.locator(".issue-facts .status")).toHaveText("unresolved");
});

test("lists a release created through the API, with its deploy", async ({
  page,
}) => {
  const version = `ui-f-${Date.now()}@1.0.0`;
  await api("/projects/default/default/releases/", {
    method: "POST",
    body: JSON.stringify({ version }),
  });
  await api(
    `/projects/default/default/releases/${encodeURIComponent(version)}/deploys/`,
    {
      method: "POST",
      body: JSON.stringify({ environment: "production", name: "deploy one" }),
    },
  );
  await login(page);
  await page.getByRole("tab", { name: "Releases" }).click();
  await expect(page).toHaveURL(/\/default\/default\/releases$/);
  const row = page.getByRole("row", { name: new RegExp(version) });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell").last()).toHaveText("1");
  await row.getByRole("link", { name: version }).click();
  await expect(page.getByRole("heading", { name: version })).toBeVisible();
  const deploys = page.locator(".deploys-table");
  await expect(deploys).toContainText("production");
  await expect(deploys).toContainText("deploy one");
  await expect(page.getByText("No source map bundles uploaded")).toBeVisible();
});

test("the settings page says so when the server has no ingest URL", async ({
  page,
}) => {
  // `stacks/local.ts` sets no publicUrl, so the key list carries no DSN.
  await login(page);
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByTestId("no-dsn")).toContainText("publicUrl");
  await expect(page.getByTestId("no-dsn")).toContainText("publicIngestUrl");
  await expect(page.locator("#limits")).toContainText("Retention");
  await expect(page.locator("#cli")).toContainText(
    "export SENTRY_ORG='default'",
  );
  await expect(page.locator("#cli")).toContainText("export SENTRY_URL='http");
  await expect(page.locator("#cli")).toContainText("<your API token>");
  expect(await page.locator("main").innerText()).not.toContain(token());
});

test("the settings page shows the DSN with a copy button and SDK snippets", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // The local stack has no ingest URL; add a DSN to the real key list the way a configured
  // server would build it.
  const dsn = "http://0123456789abcdef@127.0.0.1:8787/1";
  await page.route("**/api/0/projects/default/default/keys/", async (route) => {
    const keys = (await (await route.fetch()).json()) as Record<
      string,
      unknown
    >[];
    await route.fulfill({
      json: keys.map((key) => ({ ...key, dsn: { public: dsn } })),
    });
  });
  await login(page);
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByTestId("dsn").first()).toHaveText(dsn);
  await page.getByRole("button", { name: "Copy the DSN" }).click();
  await expect(page.getByText("Copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(dsn);
  const snippets = page.locator(".snippet");
  await expect(snippets.nth(0)).toContainText(`dsn: "${dsn}"`);
  await expect(snippets.nth(0)).toContainText("@sentry/browser");
  await expect(snippets.nth(1)).toContainText("@sentry/node");
  await expect(snippets.nth(2)).toContainText(`dsn="${dsn}"`);
  await page.getByRole("button", { name: "Copy the Python snippet" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "sentry_sdk.init",
  );
});

test("dark mode: the toggle sets data-theme and survives a reload", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await login(page);
  const html = page.locator("html");
  const background = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.body.parentElement as Element)
          .backgroundColor,
    );
  await expect(html).not.toHaveAttribute("data-theme", /.+/);
  const light = await background();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  const dark = await background();
  expect(dark).not.toBe(light);
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Dark" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await background()).toBe(dark);
  // System follows the browser: a dark system gets the dark palette without data-theme.
  await page.getByRole("button", { name: "System" }).click();
  await expect(html).not.toHaveAttribute("data-theme", /.+/);
  expect(await background()).toBe(light);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await background()).toBe(dark);
  // An explicit light choice wins over a dark system.
  await page.getByRole("button", { name: "Light" }).click();
  expect(await background()).toBe(light);
});

test("downloads the raw event JSON under the build's CSP", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: /checkout failed/ }).click();
  await expect(page.locator(".issue-title-full")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^event-[A-Za-z0-9._-]+\.json$/);
  const path = await download.path();
  const { readFile } = await import("node:fs/promises");
  const body = JSON.parse(await readFile(path, "utf8")) as {
    eventID: string;
    entries: unknown[];
  };
  expect(body.eventID).toMatch(/^[0-9a-f]{32}$/);
  expect(body.entries.length).toBeGreaterThan(0);
});
