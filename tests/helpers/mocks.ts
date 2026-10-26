// Factory bodies for the vi.mock blocks that repeat across suites:
//
//   vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
//   vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
//   vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
//   vi.mock("@/lib/auth/admin", async () => (await import("@/tests/helpers/mocks")).adminModule());
//   vi.mock("@/lib/notifications/resolved-hold", async (orig) => (await import("@/tests/helpers/mocks")).resolvedHoldModule(orig));
//   vi.mock("ioredis", async () => (await import("@/tests/helpers/mocks")).ioredisModule());
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

/** The resolution hold without Redis: holds and sends nothing. The notice builder stays real. */
export async function resolvedHoldModule(importOriginal: () => Promise<unknown>) {
  const real = (await importOriginal()) as typeof import("@/lib/notifications/resolved-hold");
  return {
    ...real,
    holdResolved: vi.fn(async () => {}),
    sendHeldResolved: vi.fn(async () => false),
    flushResolved: vi.fn(async () => 0),
  };
}

/** An ioredis that never connects: `set` succeeds, other commands resolve null, pipeline and multi resolve no results. */
export function ioredisModule() {
  const batch: object = new Proxy({}, {
    get: (_, prop) => (prop === "exec" ? async () => [] : prop === "then" ? undefined : () => batch),
  });
  const client: object = new Proxy({}, {
    get: (_, prop) => {
      if (prop === "then") return undefined;
      if (prop === "pipeline" || prop === "multi") return () => batch;
      if (prop === "on" || prop === "once" || prop === "off") return () => client;
      if (prop === "set") return vi.fn(async () => "OK");
      return vi.fn(async () => null);
    },
  });
  return {
    default: class {
      constructor() {
        return client;
      }
    },
  };
}
