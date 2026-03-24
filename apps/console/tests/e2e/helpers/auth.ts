import { type Page } from "@playwright/test";

/**
 * Log in via the email/password form.
 *
 * Requires a running dev server and a seeded user account.
 * See `seed.ts` for required seed data.
 */
export async function login(
  page: Page,
  email = process.env.TEST_USER_EMAIL ?? "admin@host.test",
  password = process.env.TEST_USER_PASSWORD ?? "TestPassword123!",
) {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in with password/i }).click();

  // Wait for redirect away from the login page
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 10_000,
  });
}
