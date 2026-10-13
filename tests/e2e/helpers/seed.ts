import type { Page } from "@playwright/test";

/** Create the first admin on a fresh scratch instance. */
export async function setupScratchAdmin(page: Page, email: string) {
  await page.goto("/setup");
  await page.getByLabel("Setup token").fill("e2e-setup-token-0123456789");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Lifecycle E2E");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill("TestPassword123!");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/projects");
}
