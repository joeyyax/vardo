import { test, expect } from "@playwright/test";

test("the login page loads", async ({ page }) => {
  const response = await page.goto("/login");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Sign in/);
});

test("a fresh instance asks for the setup token", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Enter your setup token" })).toBeVisible();
  await expect(page.getByLabel("Setup token")).toBeVisible();
});

test("a wrong setup token is refused", async ({ page }) => {
  await page.goto("/setup");
  await page.getByLabel("Setup token").fill("not-the-token-0123456789");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Enter your setup token" })).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
});

test("the right setup token opens the wizard", async ({ page }) => {
  await page.goto("/setup");
  await page.getByLabel("Setup token").fill("e2e-setup-token-0123456789");
  await page.getByRole("button", { name: "Continue" }).click();
  // The first render of the wizard compiles it under `next dev`.
  await expect(page.getByRole("heading", { name: "Enter your setup token" })).toBeHidden({ timeout: 30_000 });
});
