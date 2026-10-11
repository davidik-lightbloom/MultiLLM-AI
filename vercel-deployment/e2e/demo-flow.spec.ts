import { test, expect } from "@playwright/test";

// End-to-end demo flow against a real deployed app (configurable via
// E2E_BASE_URL -- see playwright.config.ts), using a real test account:
//   E2E_TEST_EMAIL / E2E_TEST_PASSWORD
//
// The test account must already have the one sample client project that
// scripts/demo-account.mjs seeds on `create` ("Sample Client Project"), and
// at least one connected provider (platform keys or BYO) so a real query
// succeeds.
//
// Flow: log in -> open the sample client project (tag a query to it from the
// home page) -> ask a question -> see the final answer and its metrics ->
// open Analytics filtered to that project and confirm the query shows up.
//
// Not run in CI on every push -- see .github/workflows/e2e.yml
// (workflow_dispatch only) and the "test:e2e" npm script.

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
const SAMPLE_PROJECT_NAME = "Sample Client Project";

test.skip(!EMAIL || !PASSWORD, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD must be set to run the demo flow test");

test("demo flow: login, ask a question tagged to the sample project, see the answer, see it in analytics", async ({
  page,
}) => {
  // 1. Log in.
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL!);
  await page.locator("#password").fill(PASSWORD!);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/dashboard/);
  // Not getByText(/Welcome back/i): a "Welcome back!" toast and the route
  // announcer div both also match that text, making a plain text locator
  // ambiguous under Playwright's strict mode. The dashboard heading is the
  // one that actually confirms the page loaded.
  await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();

  // 2. Go ask a question, tagged to the sample client project.
  await page.goto("/#try-it");
  await page.locator("#project-select").selectOption({ label: SAMPLE_PROJECT_NAME });

  const prompt = `E2E demo flow check ${Date.now()}`;
  await page.getByPlaceholder(/Ask anything/i).fill(prompt);
  await page.getByRole("button", { name: /Ask MultiLLM|Running ensemble/i }).click();

  // 3. See the final answer and its metrics (this app surfaces the merged
  // ensemble answer plus aggregate scores, not a per-candidate breakdown --
  // see src/app/page.tsx). Scoped to the "Best Answer" result heading (an
  // <h2>) specifically: the homepage's own static marketing copy also
  // contains "Best Answer Selection" and "Best Answer Returned", which a
  // plain text locator matches too under Playwright's strict mode.
  await expect(page.getByRole("heading", { name: "Best Answer", exact: true })).toBeVisible({ timeout: 45_000 });
  // exact: true -- getByText's default substring match is case-insensitive,
  // so a plain "Confidence" also matches the Deep Review checkbox's label
  // ("...for a confidence score").
  await expect(page.getByText("Confidence", { exact: true })).toBeVisible();

  // 4. Open Analytics filtered to that project and confirm the query shows up.
  await page.goto("/dashboard/analytics");
  await page.getByTestId("analytics-project-select").selectOption({ label: SAMPLE_PROJECT_NAME });
  await expect(page.getByText(/No queries yet/i)).not.toBeVisible();
});
