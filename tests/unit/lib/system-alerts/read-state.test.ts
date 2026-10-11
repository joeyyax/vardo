import { beforeEach, describe, expect, it, vi } from "vitest";

const row = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      systemSettings: {
        findFirst: vi.fn(async () => (row.value === null ? undefined : { key: "system_alert_state", value: row.value })),
      },
    },
  },
}));

import { getAlertState, readAlertState } from "@/lib/system-alerts/state";

describe("readAlertState", () => {
  beforeEach(() => {
    row.value = null;
  });

  it("reads what the process running the loop persisted, not this process's memory", async () => {
    row.value = JSON.stringify({
      "service-degraded:85": { lastFired: "2026-10-01T00:00:00.000Z", count: 2 },
      "cert-expiring:example.com": { lastFired: "2026-10-02T00:00:00.000Z", count: 1 },
    });

    const alerts = await readAlertState();

    expect(getAlertState()).toEqual([]);
    expect(alerts).toEqual([
      { type: "service-degraded", key: "85", lastFired: new Date("2026-10-01T00:00:00.000Z"), count: 2 },
      { type: "cert-expiring", key: "example.com", lastFired: new Date("2026-10-02T00:00:00.000Z"), count: 1 },
    ]);
  });

  it("is empty before anything was persisted", async () => {
    expect(await readAlertState()).toEqual([]);
  });
});
