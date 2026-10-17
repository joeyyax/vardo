import { describe, expect, it } from "vitest";
import { appNotRunning, autoIntervalFor } from "@/lib/uptime/auto";
import { weighCheck } from "@/lib/uptime/core";

const ran = new Date("2026-01-01");

describe("appNotRunning", () => {
  it.each([
    ["stopped through Vardo", { status: "stopped", parked: true, lastRunningAt: ran }, true],
    ["parked and exited non-zero on the way down", { status: "error", parked: true, lastRunningAt: ran }, true],
    ["parked with the containers removed", { status: "missing", parked: true, lastRunningAt: ran }, true],
    ["parked while the stop is still landing", { status: "active", parked: true, lastRunningAt: ran }, true],
    ["stopped by a signal outside Vardo", { status: "stopped", parked: false, lastRunningAt: ran, exitReason: { signal: "SIGTERM" } }, true],
    ["never started", { status: "missing", parked: false, lastRunningAt: null }, true],
    ["created and never deployed", { status: "stopped", parked: false, lastRunningAt: null }, true],
  ])("%s: not running", (_name, app, expected) => expect(appNotRunning(app)).toBe(expected));

  it.each([
    ["running", { status: "active", parked: false, lastRunningAt: ran }],
    ["crashed with a non-zero exit or OOM kill", { status: "error", parked: false, lastRunningAt: ran }],
    ["segfaulted", { status: "stopped", parked: false, lastRunningAt: ran, exitReason: { signal: "SIGSEGV" } }],
    ["vanished after running", { status: "missing", parked: false, lastRunningAt: ran }],
    ["deploying after a stop", { status: "deploying", parked: true, lastRunningAt: ran }],
  ])("%s: an outage when down", (_name, app) => expect(appNotRunning(app)).toBe(false));

  it("leaves monitors without an app alone", () => expect(appNotRunning(null)).toBe(false));
});

describe("autoIntervalFor", () => {
  it("backs a homepage fallback off to 5 minutes, keeps the rest at 1, and lets an edit win", () => {
    expect(autoIntervalFor({ healthSource: "homepage" })).toBe(300);
    for (const source of ["probe", "healthcheck", "image", null]) expect(autoIntervalFor({ healthSource: source })).toBe(60);
    expect(autoIntervalFor({ healthSource: "homepage", overrides: { intervalSec: 30 } })).toBe(30);
  });
});

describe("weighCheck", () => {
  const ok = (bytes: number | undefined, latencyMs: number, cache?: "cloudflare") => ({ ok: true, latencyMs, ...(bytes !== undefined ? { bytes } : {}), ...(cache ? { cache } : {}) });

  it("flags a large page or a slow one once there are three answers", () => {
    expect(weighCheck([ok(412_000, 80), ok(412_000, 90)])).toBeNull();
    expect(weighCheck([ok(412_000, 80), ok(412_000, 90), ok(412_000, 85)])).toMatchObject({ heavy: true, slow: false, bytes: 412_000, atLeast: false });
    expect(weighCheck([ok(300, 900), ok(300, 800), ok(300, 700)])).toMatchObject({ heavy: false, slow: true, medianMs: 800 });
    expect(weighCheck([ok(65_536, 50), ok(65_536, 50), ok(65_536, 50)])).toMatchObject({ atLeast: true });
  });

  it("ignores light fast answers, failures and cached answers", () => {
    expect(weighCheck([ok(300, 40), ok(300, 50), ok(300, 45)])).toBeNull();
    expect(weighCheck([ok(412_000, 80, "cloudflare"), ok(412_000, 80, "cloudflare"), ok(412_000, 80, "cloudflare")])).toBeNull();
    expect(weighCheck([{ ok: false, latencyMs: 9000 }, { ok: false, latencyMs: 9000 }, { ok: false, latencyMs: 9000 }])).toBeNull();
  });
});
