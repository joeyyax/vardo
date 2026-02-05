import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("public routes should be accessible", async ({ page }) => {
    // Login page is public
    await page.goto("/login");
    await expect(page.locator("body")).toBeVisible();
  });

  test("protected routes should redirect to login", async ({ page }) => {
    // Try to access protected route
    await page.goto("/track");
    // Should redirect to login or onboarding
    await expect(page).toHaveURL(/\/(login|onboarding)/);
  });

  test("onboarding page should be accessible", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page.locator("body")).toBeVisible();
  });
});
