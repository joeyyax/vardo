/**
 * Seed data requirements for e2e tests.
 *
 * Before running e2e tests, the database must contain:
 *
 * 1. Admin user
 *    - email: admin@host.test (or TEST_USER_EMAIL env var)
 *    - password: TestPassword123! (or TEST_USER_PASSWORD env var)
 *
 * 2. Organization
 *    - name: "Test Org"
 *    - The admin user must be a member
 *
 * You can create this manually via the onboarding flow, or automate it
 * with a seed script that calls the Better Auth API directly:
 *
 *   POST /api/auth/sign-up/email
 *   { email, password, name }
 *
 * TODO: Implement programmatic seeding via a setup script.
 */

export const TEST_USER = {
  email: process.env.TEST_USER_EMAIL ?? "admin@host.test",
  password: process.env.TEST_USER_PASSWORD ?? "TestPassword123!",
  name: "Test Admin",
};

export const TEST_ORG = {
  name: "Test Org",
};
