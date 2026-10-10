import { describe, it, expect, vi } from "vitest";

const betterAuth = vi.hoisted(() => vi.fn((options: unknown) => ({ options })));

vi.mock("better-auth", () => ({ betterAuth }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: vi.fn(() => ({})) }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { auth } = await import("@/lib/auth");

describe("auth config", () => {
  it("revokes every session on password reset", () => {
    const options = (auth as unknown as { options: { emailAndPassword: Record<string, unknown> } }).options;
    expect(options.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
  });
});
