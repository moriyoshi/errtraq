import { expect, type Page, test } from "@playwright/test";

const base = () => process.env.ERRTRAQ_UI_URL ?? "";
const token = () => process.env.ERRTRAQ_TOKEN ?? "";
const issuesUrl = /\/default\/default\/issues(\?.*)?$/;

async function login(page: Page) {
  await page.goto(`${base()}/`);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("API token").fill(token());
  await page.getByRole("button", { name: "Sign in" }).click();
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

test("rejects a bad token and accepts the local one", async ({ page }) => {
  await page.goto(`${base()}/login`);
  await page.getByLabel("API token").fill("not-a-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("not accepted");
  await page.getByLabel("API token").fill(token());
  await page.getByRole("button", { name: "Sign in" }).click();
  // One organization and one project: both are selected automatically.
  await expect(page).toHaveURL(issuesUrl);
});

test("lists issues, filters by status and sorts via the URL", async ({
  page,
}) => {
  await login(page);
  await expect(page).toHaveURL(issuesUrl);
  await expect(
    page.getByRole("link", { name: /checkout failed/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /inventory out of range/ }),
  ).toBeVisible();
  const rows = page.locator(".issue-row");
  await expect(rows).toHaveCount(2);
  // The checkout issue has three events and is the more frequent one.
  await page.getByLabel("Sort").selectOption("freq");
  await expect(page).toHaveURL(/sort=freq/);
  await expect(rows.first()).toContainText("checkout failed");
  await expect(rows.first().locator(".num")).toHaveText("3");
  await page.getByRole("tab", { name: "resolved", exact: true }).click();
  await expect(page).toHaveURL(/status=resolved/);
  await expect(page.getByText("No resolved issues.")).toBeVisible();
});

test("shows the stack trace and navigates between events", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: /checkout failed/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "checkout failed",
  );
  await expect(page.locator(".exc-type").first()).toHaveText("TypeError");
  await expect(page.locator(".frame.in-app").first()).toContainText(
    "checkoutFailure",
  );
  await expect(page.locator(".code li.current").first()).toContainText(
    "checkout failed",
  );
  await expect(
    page.getByRole("heading", { name: /Breadcrumbs/ }),
  ).toBeVisible();
  const latestId = await page.locator(".meta .mono").first().textContent();
  // Latest event: no newer one.
  await expect(page.locator(".event-nav .btn.disabled")).toContainText([
    "Newer",
    "Latest",
  ]);
  await page.getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/[?&]event=[0-9a-f]{32}/);
  await expect(page.locator(".meta .mono").first()).not.toHaveText(
    latestId ?? "",
  );
  await page.getByRole("link", { name: "Oldest" }).click();
  await expect(page.getByRole("link", { name: "Older" })).toHaveCount(0);
  await page.getByRole("link", { name: "Latest" }).click();
  await expect(page.locator(".meta .mono").first()).toHaveText(latestId ?? "");
  await page.getByRole("tab", { name: "Events" }).click();
  await expect(page.locator(".events-table tbody tr")).toHaveCount(3);
  await page.locator(".events-table tbody tr a").first().click();
  await expect(page).toHaveURL(/[?&]event=/);
  await expect(page.locator(".exception")).toBeVisible();
});

test("resolves and unresolves an issue", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: /inventory out of range/ }).click();
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(".issue-facts .status")).toHaveText("resolved");
  await page.reload();
  await expect(page.locator(".issue-facts .status")).toHaveText("resolved");
  await page.getByRole("button", { name: "Unresolve" }).click();
  await expect(page.locator(".issue-facts .status")).toHaveText("unresolved");
  await page.reload();
  await expect(page.locator(".issue-facts .status")).toHaveText("unresolved");
});

test("a 401 returns to the login page and logout clears the session", async ({
  page,
}) => {
  await login(page);
  await expect(page).toHaveURL(issuesUrl);
  await page.evaluate(() => sessionStorage.setItem("errtraq.token", "revoked"));
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  expect(
    await page.evaluate(() => sessionStorage.getItem("errtraq.token")),
  ).toBeNull();
  await login(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(
    await page.evaluate(() => sessionStorage.getItem("errtraq.token")),
  ).toBeNull();
});
