import { describe, expect, it } from "vitest";
import { combinePower, upsPower, type PowerState } from "@/lib/ups/power-state";
import { advance, readingFromVars } from "@/lib/ups/status";
import {
  RESTORE_SETTLE_MS,
  decideStep,
  holdsDeploys,
  planRestarts,
  planStops,
  skipsBackups,
  stopTrigger,
  type StopCandidate,
} from "@/lib/power/policy";
import { DEFAULT_POWER_POLICIES, parsePowerPolicies, type PowerPolicies } from "@/lib/power/settings";

const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** One UPS reporting `status`, its outage started `outageAgoMs` ago and last read `readAgoMs` ago. */
function power(status: string, opts: { outageAgoMs?: number; readAgoMs?: number; charge?: number; at?: Date } = {}): PowerState {
  const at = opts.at ?? NOW;
  const vars = { "ups.status": status, "battery.charge": String(opts.charge ?? 80), "battery.runtime": "1200" };
  const { state } = advance(null, { ok: true, reading: readingFromVars(vars) }, new Date(at.getTime() - (opts.outageAgoMs ?? 0)));
  const read = { ...state, lastOkAt: new Date(at.getTime() - (opts.readAgoMs ?? 1_000)).toISOString() };
  return combinePower([upsPower({ id: "u1", name: "UPS", onBatteryGraceSec: 30 }, read, at)]);
}

const STOP: PowerPolicies = { ...DEFAULT_POWER_POLICIES, stopApps: true, stopAfterMinutes: 10, stopBelowCharge: 30 };

describe("backup and deploy gates", () => {
  it("skip and hold on battery once the grace period is past", () => {
    const p = power("OB DISCHRG", { outageAgoMs: 60_000 });
    expect(skipsBackups(p, DEFAULT_POWER_POLICIES)).toBe(true);
    expect(holdsDeploys(p, DEFAULT_POWER_POLICIES)).toBe(true);
  });

  it("wait out the grace period", () => {
    const p = power("OB DISCHRG", { outageAgoMs: 10_000 });
    expect(skipsBackups(p, DEFAULT_POWER_POLICIES)).toBe(false);
    expect(holdsDeploys(p, DEFAULT_POWER_POLICIES)).toBe(false);
  });

  it("do nothing on mains", () => {
    const p = power("OL CHRG");
    expect(skipsBackups(p, DEFAULT_POWER_POLICIES)).toBe(false);
    expect(holdsDeploys(p, DEFAULT_POWER_POLICIES)).toBe(false);
  });

  it("treat a stale on-battery reading as unknown", () => {
    const p = power("OB DISCHRG", { outageAgoMs: 10 * 60_000, readAgoMs: 5 * 60_000 });
    expect(skipsBackups(p, DEFAULT_POWER_POLICIES)).toBe(false);
    expect(holdsDeploys(p, DEFAULT_POWER_POLICIES)).toBe(false);
    expect(stopTrigger(p, STOP, NOW)).toBeNull();
  });

  it("do nothing with no UPS", () => {
    const p = combinePower([]);
    expect(skipsBackups(p, DEFAULT_POWER_POLICIES)).toBe(false);
    expect(decideStep({ power: p, policies: STOP, now: NOW, mainsSince: ago(10 * 60_000).getTime(), openStops: 3, stoppedOutage: null }).step.action).toBe("none");
  });

  it("stay off when the admin turns them off", () => {
    const p = power("OB DISCHRG", { outageAgoMs: 60_000 });
    const off = { ...DEFAULT_POWER_POLICIES, skipBackups: false, holdDeploys: false };
    expect(skipsBackups(p, off)).toBe(false);
    expect(holdsDeploys(p, off)).toBe(false);
  });
});

describe("stop trigger", () => {
  it("fires after the minutes on battery", () => {
    expect(stopTrigger(power("OB", { outageAgoMs: 9 * 60_000 }), STOP, NOW)).toBeNull();
    expect(stopTrigger(power("OB", { outageAgoMs: 10 * 60_000 }), STOP, NOW)).toMatchObject({ reason: "minutes" });
  });

  it("fires at the charge level before the minutes are up", () => {
    expect(stopTrigger(power("OB", { outageAgoMs: 60_000, charge: 31 }), STOP, NOW)).toBeNull();
    expect(stopTrigger(power("OB", { outageAgoMs: 60_000, charge: 30 }), STOP, NOW)).toMatchObject({ reason: "charge", text: "at 30% charge" });
  });

  it("ignores a trigger the admin left blank", () => {
    const chargeOnly = { ...STOP, stopAfterMinutes: null };
    expect(stopTrigger(power("OB", { outageAgoMs: 60 * 60_000 }), chargeOnly, NOW)).toBeNull();
  });

  it("is off by default", () => {
    expect(DEFAULT_POWER_POLICIES.stopApps).toBe(false);
    expect(stopTrigger(power("OB", { outageAgoMs: 60 * 60_000, charge: 5 }), DEFAULT_POWER_POLICIES, NOW)).toBeNull();
  });

  it("never fires on mains, even at a low charge", () => {
    expect(stopTrigger(power("OL CHRG", { charge: 10 }), STOP, NOW)).toBeNull();
  });
});

function app(name: string, over: Partial<StopCandidate> = {}): StopCandidate {
  return {
    id: name,
    name,
    displayName: name,
    organizationId: "o1",
    parentAppId: null,
    status: "active",
    parked: false,
    priority: "standard",
    isSystemManaged: false,
    keepRunningOnBattery: false,
    ...over,
  };
}

describe("stop plan", () => {
  it("stops lowest priority first and restarts in the reverse order", () => {
    const apps = [app("db", { priority: "critical" }), app("web"), app("preview", { priority: "disposable" }), app("api", { priority: null })];
    const stops = planStops(apps).map((a) => a.name);
    expect(stops).toEqual(["preview", "api", "web", "db"]);
    expect(planRestarts(planStops(apps)).map((a) => a.name)).toEqual(["db", "api", "web", "preview"]);
  });

  it("never stops an app kept on battery, Vardo's own or a core service", () => {
    const apps = [
      app("keep", { keepRunningOnBattery: true }),
      app("vardo"),
      app("vardo-frontend"),
      app("loki", { isSystemManaged: true }),
      app("blog"),
    ];
    expect(planStops(apps).map((a) => a.name)).toEqual(["blog"]);
  });

  it("leaves stopped apps, parked apps and compose children alone", () => {
    const apps = [app("off", { status: "stopped" }), app("parked", { parked: true }), app("child", { parentAppId: "stack" }), app("stack")];
    expect(planStops(apps).map((a) => a.name)).toEqual(["stack"]);
  });
});

describe("stop and restart steps", () => {
  const onBattery = (outageAgoMs: number, at = NOW) => power("OB DISCHRG", { outageAgoMs, at });

  it("stops once per outage", () => {
    const p = onBattery(11 * 60_000);
    const outage = p.since!.toISOString();
    expect(decideStep({ power: p, policies: STOP, now: NOW, mainsSince: null, openStops: 0, stoppedOutage: null }).step).toMatchObject({ action: "stop", outage });
    expect(decideStep({ power: p, policies: STOP, now: NOW, mainsSince: null, openStops: 4, stoppedOutage: outage }).step.action).toBe("none");
  });

  it("restarts only after mains holds for the settle time", () => {
    const mains = power("OL CHRG");
    const first = decideStep({ power: mains, policies: STOP, now: NOW, mainsSince: null, openStops: 2, stoppedOutage: null });
    expect(first).toEqual({ step: { action: "none" }, mainsSince: NOW.getTime() });
    const early = new Date(NOW.getTime() + RESTORE_SETTLE_MS - 1_000);
    expect(decideStep({ power: power("OL", { at: early }), policies: STOP, now: early, mainsSince: first.mainsSince, openStops: 2, stoppedOutage: null }).step.action).toBe("none");
    const settled = new Date(NOW.getTime() + RESTORE_SETTLE_MS);
    expect(decideStep({ power: power("OL", { at: settled }), policies: STOP, now: settled, mainsSince: first.mainsSince, openStops: 2, stoppedOutage: null }).step.action).toBe("restart");
  });

  it("starts the settle over when power bounces", () => {
    let mainsSince: number | null = null;
    const step = (p: PowerState, at: Date) => {
      const d = decideStep({ power: p, policies: STOP, now: at, mainsSince, openStops: 3, stoppedOutage: "earlier" });
      mainsSince = d.mainsSince;
      return d.step.action;
    };
    const t = (s: number) => new Date(NOW.getTime() + s * 1_000);
    expect(step(power("OL", { at: t(0) }), t(0))).toBe("none");
    expect(step(power("OL", { at: t(90) }), t(90))).toBe("none");
    expect(step(power("OB", { at: t(100) }), t(100))).toBe("none");
    expect(step(power("OL", { at: t(110) }), t(110))).toBe("none");
    expect(step(power("OL", { at: t(200) }), t(200))).toBe("none");
    expect(step(power("OL", { at: t(230) }), t(230))).toBe("restart");
  });

  it("holds stopped apps while readings are stale", () => {
    const stale = power("OL", { readAgoMs: 5 * 60_000 });
    expect(decideStep({ power: stale, policies: STOP, now: NOW, mainsSince: ago(10 * 60_000).getTime(), openStops: 2, stoppedOutage: null })).toEqual({ step: { action: "none" }, mainsSince: null });
  });
});

describe("stored policies", () => {
  it("keeps defaults for a missing or broken value", () => {
    expect(parsePowerPolicies(null)).toEqual(DEFAULT_POWER_POLICIES);
    expect(parsePowerPolicies("{not json")).toEqual(DEFAULT_POWER_POLICIES);
    expect(parsePowerPolicies(JSON.stringify({ stopApps: true, stopAfterMinutes: 5 }))).toMatchObject({ stopApps: true, stopAfterMinutes: 5, skipBackups: true });
  });
});
