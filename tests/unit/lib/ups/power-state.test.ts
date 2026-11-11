import { describe, expect, it } from "vitest";
import { POWER_FRESH_MS, combinePower, upsPower } from "@/lib/ups/power-state";
import { advance, readingFromVars, type UpsState } from "@/lib/ups/status";

const NOW = new Date("2026-11-11T12:00:00Z");

function stateAt(status: string, runtime: string, readAgoMs: number, since?: Date): UpsState {
  const { state } = advance(null, { ok: true, reading: readingFromVars({ "ups.status": status, "battery.charge": "70", "battery.runtime": runtime }) }, since ?? new Date(NOW.getTime() - readAgoMs));
  return { ...state, lastOkAt: new Date(NOW.getTime() - readAgoMs).toISOString() };
}

describe("power state", () => {
  it("reports on battery with the outage start and the shortest runtime", () => {
    const outage = new Date(NOW.getTime() - 120_000);
    const power = combinePower([
      upsPower({ id: "a", name: "A", onBatteryGraceSec: 30 }, stateAt("OB DISCHRG", "900", 5_000, outage), NOW),
      upsPower({ id: "b", name: "B", onBatteryGraceSec: 30 }, stateAt("OL", "300", 5_000), NOW),
    ]);
    expect(power).toMatchObject({ monitored: true, onBattery: true, runtimeSec: 900, charge: 70, fresh: true });
    expect(power.since?.toISOString()).toBe(outage.toISOString());
  });

  it("reports on battery from the first poll and the grace period separately", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    const early = combinePower([upsPower({ id: "a", name: "A", onBatteryGraceSec: 30 }, stateAt("OB", "900", 0, at(10_000)), NOW)]);
    const late = combinePower([upsPower({ id: "a", name: "A", onBatteryGraceSec: 30 }, stateAt("OB", "900", 0, at(30_000)), NOW)]);
    expect(early).toMatchObject({ onBattery: true, graceElapsed: false });
    expect(late).toMatchObject({ onBattery: true, graceElapsed: true });
  });

  it("doesn't trust a stale on-battery reading", () => {
    const power = combinePower([upsPower({ id: "a", name: "A", onBatteryGraceSec: 30 }, stateAt("OB", "900", POWER_FRESH_MS + 1), NOW)]);
    expect(power.onBattery).toBe(false);
    expect(power.fresh).toBe(false);
    expect(power.upses[0].onBattery).toBe(true);
  });

  it("is unmonitored with no UPS", () => {
    expect(combinePower([])).toMatchObject({ monitored: false, onBattery: false, fresh: false, charge: null });
  });

  it("is never fresh without a good reading", () => {
    expect(upsPower({ id: "a", name: "A", onBatteryGraceSec: 30 }, null, NOW).fresh).toBe(false);
  });
});
