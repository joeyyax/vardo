import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "3110";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "lifecycle.test.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: `E2E_PORT=${port} E2E_REDIS_DB=14 VARDO_FEATURE_METRICS=false VARDO_FEATURE_LOGGING=false node tests/e2e/serve.mjs`,
    url: `${baseURL}/login`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
