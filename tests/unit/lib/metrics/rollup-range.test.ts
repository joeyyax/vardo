import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

import { msUntilNextRun, rollupCutoff, rollupRange } from "@/lib/metrics/rollup";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 10, 12, 5);
const CURRENT = Date.UTC(2026, 9, 10, 12);

describe("rollupRange", () => {
  it("re-rolls the two hours before the current one", () => {
    expect(rollupRange(NOW, CURRENT)).toEqual({ fromMs: CURRENT - 2 * HOUR, toMs: CURRENT });
  });

  it("resumes from an older watermark", () => {
    expect(rollupRange(NOW, CURRENT - 9 * HOUR).fromMs).toBe(CURRENT - 9 * HOUR);
  });

  it("starts at the oldest whole hour still in raw retention without a watermark or past it", () => {
    const oldest = Math.ceil((NOW - 7 * 24 * HOUR) / HOUR) * HOUR;
    expect(rollupRange(NOW, null).fromMs).toBe(oldest);
    expect(rollupRange(NOW, CURRENT - 30 * 24 * HOUR).fromMs).toBe(oldest);
  });
});

describe("rollupCutoff", () => {
  it("is thirteen calendar months before the current hour", () => {
    expect(rollupCutoff(NOW).toISOString()).toBe("2025-09-10T12:00:00.000Z");
  });
});

describe("msUntilNextRun", () => {
  it("waits for five past the hour", () => {
    expect(msUntilNextRun(Date.UTC(2026, 9, 10, 12, 0))).toBe(5 * 60_000);
    expect(msUntilNextRun(NOW)).toBe(HOUR);
    expect(msUntilNextRun(Date.UTC(2026, 9, 10, 12, 50))).toBe(15 * 60_000);
  });
});
