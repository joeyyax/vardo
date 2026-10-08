// Factory bodies for the vi.mock blocks that repeat across suites:
//
//   vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
//   vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
//   vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
//   vi.mock("@/lib/auth/admin", async () => (await import("@/tests/helpers/mocks")).adminModule());
import { vi } from "vitest";

export function loggerModule() {
  const log: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  log.child = () => log;
  return { logger: log };
}

/** withRateLimit that calls the handler straight through. */
export function withRateLimitModule() {
  return {
    withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
  };
}

/** rateLimit that never limits. */
export function rateLimitModule() {
  return { rateLimit: vi.fn().mockResolvedValue(null) };
}

/** isAppAdmin false by default; override with `.mockResolvedValue(true)`. */
export function adminModule() {
  return {
    isAppAdmin: vi.fn().mockResolvedValue(false),
    requireAppAdmin: vi.fn().mockResolvedValue(null),
  };
}
