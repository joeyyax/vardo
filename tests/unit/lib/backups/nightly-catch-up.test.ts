import { beforeEach, describe, expect, it, vi } from "vitest";
import { missedNightlyKey, NIGHTLY_CATCH_UP_MS } from "@/lib/backups/run-rules";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/time-zone-settings", () => ({
  getInstanceTimeZone: async () => "UTC",
  resolveTimeZone: (org: string | null, instance: string) => org ?? instance,
}));
vi.mock("@/lib/resources/host", () => ({ loadResourceSettings: async () => {}, maxDeployConcurrency: () => 2 }));

import { dbMock } from "@/tests/helpers/db";
const { startNightlyRuns } = await import("@/lib/backups/runs");

const LA = "America/Los_Angeles";

describe("missedNightlyKey", () => {
  it("keys the run missed earlier today", () => {
    expect(missedNightlyKey("02:00", new Date("2026-10-13T03:10:00Z"))).toBe("nightly:2026-10-13");
  });

  it("is null in the run's own minute and once the window has passed", () => {
    expect(missedNightlyKey("02:00", new Date("2026-10-13T02:00:30Z"))).toBeNull();
    expect(missedNightlyKey("02:00", new Date(Date.parse("2026-10-13T02:00:00Z") + NIGHTLY_CATCH_UP_MS + 60_000))).toBeNull();
  });

  it("reaches back across midnight in the org's zone", () => {
    // 23:30 on Oct 12 in Los Angeles, missed until 01:00 on Oct 13.
    expect(missedNightlyKey("23:30", new Date("2026-10-13T08:00:00Z"), LA)).toBe("nightly:2026-10-12");
  });

  it("is null before today's time when yesterday's is out of the window", () => {
    expect(missedNightlyKey("02:00", new Date("2026-10-13T01:00:00Z"))).toBeNull();
  });
});

describe("startNightlyRuns catch-up", () => {
  const jobRows = [
    { id: "j1", organizationId: "org1", time: "02:00", timeZone: null },
    { id: "j2", organizationId: "org1", time: "02:00", timeZone: null },
  ];

  beforeEach(() => {
    dbMock.reset();
    let call = 0;
    // First select: the nightly jobs. Second: their app links.
    (dbMock.db as Record<string, unknown>).select = vi.fn(() => {
      const rows = call++ === 0 ? jobRows : [];
      const chain = { from: () => chain, innerJoin: () => chain, where: async () => rows };
      return chain;
    });
  });

  it("opens one nightly run for every job a stopped console missed", async () => {
    dbMock.query.backupRuns.findFirst.mockResolvedValue(undefined);
    dbMock.insertReturns([{ id: "run1" }]);
    const runOf = await startNightlyRuns(new Date("2026-10-13T03:10:00Z"));
    expect(dbMock.inserts).toHaveLength(1);
    expect(dbMock.inserts[0].values).toMatchObject({ kind: "nightly", runKey: "nightly:2026-10-13" });
    const runId = (dbMock.inserts[0].values as { id: string }).id;
    expect([...runOf]).toEqual([
      ["j1", runId],
      ["j2", runId],
    ]);
  });

  it("leaves a night that already ran alone", async () => {
    dbMock.query.backupRuns.findFirst.mockResolvedValue({ id: "earlier" });
    const runOf = await startNightlyRuns(new Date("2026-10-13T03:10:00Z"));
    expect(dbMock.inserts).toHaveLength(0);
    expect(runOf.size).toBe(0);
  });
});
