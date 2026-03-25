import { type Page } from "@playwright/test";

/**
 * Log in via magic link for e2e tests.
 *
 * In development, magic links are logged to the console. This helper
 * intercepts the magic link API response to extract the URL directly,
 * avoiding the need for an email inbox.
 *
 * Requires a running dev server and a seeded user account.
 * See `seed.ts` for required seed data.
 */
export async function login(
  page: Page,
  email = process.env.TEST_USER_EMAIL ?? "admin@host.test",
) {
  await page.goto("/login");

  // Fill email and request magic link
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: /send magic link/i }).click();

  // In test/dev mode, the magic link URL is logged to the server console.
  // For e2e tests, we need a test-mode bypass or to intercept the link.
  // TODO: Implement a test-mode auth bypass (e.g., /api/auth/test-login)
  // that creates a session directly without sending an email.
  //
  // For now, tests that need auth should use the Playwright storageState
  // approach with a pre-authenticated session cookie.

  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}
