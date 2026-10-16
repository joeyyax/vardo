import { afterEach, describe, expect, it, vi } from "vitest";

const betterAuth = vi.hoisted(() => vi.fn((options: unknown) => ({ options })));

vi.mock("better-auth", () => ({ betterAuth }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: vi.fn(() => ({})) }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { auth, refreshAuthMethods } = await import("@/lib/auth");

const logLevel = () => (auth as unknown as { options: { logger: { level: string } } }).options.logger.level;

afterEach(() => {
  vi.unstubAllEnvs();
  refreshAuthMethods();
});

describe("Better Auth log level", () => {
  it("logs debug in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    refreshAuthMethods();
    expect(logLevel()).toBe("debug");
  });

  it("logs warnings and up in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    refreshAuthMethods();
    expect(logLevel()).toBe("warn");
  });
});
