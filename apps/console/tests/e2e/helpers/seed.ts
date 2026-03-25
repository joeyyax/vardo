/**
 * Seed data requirements for e2e tests.
 *
 * Before running e2e tests, the database must contain:
 *
 * 1. Admin user
 *    - email: admin@host.test (or TEST_USER_EMAIL env var)
 *    - Created via the setup wizard (magic link flow)
 *
 * 2. Organization
 *    - name: "Test Org"
 *    - The admin user must be a member
 *
 * Vardo uses passwordless auth (passkey, magic link, GitHub OAuth).
 * For e2e test automation, a test-mode auth bypass is needed:
 *
 * TODO: Implement /api/auth/test-login endpoint that creates a session
 * directly when NODE_ENV=test. This avoids email dependency in CI.
 */

export const TEST_USER = {
  email: process.env.TEST_USER_EMAIL ?? "admin@host.test",
  name: "Test Admin",
};

export const TEST_ORG = {
  name: "Test Org",
};
