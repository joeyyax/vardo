import { defineConfig, devices } from "@playwright/test";

// `pnpm test:e2e` serves the app on a scratch database (tests/e2e/serve.mjs).
// Set BASE_URL to run against a server that is already up.
const PORT = process.env.E2E_PORT ?? "3100";
const baseURL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "node tests/e2e/serve.mjs",
        url: `${baseURL}/login`,
        timeout: 180_000,
        reuseExistingServer: false,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
