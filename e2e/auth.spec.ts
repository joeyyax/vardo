import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("should show login page for unauthenticated users", async ({ page }) => {
    await page.goto("/track");
    // Should redirect to login or onboarding
    await expect(page).toHaveURL(/\/(login|onboarding)/);
  });

  test("login page should render correctly", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(/Time/);
    // Page should load without errors
    await expect(page.locator("body")).toBeVisible();
  });
});
