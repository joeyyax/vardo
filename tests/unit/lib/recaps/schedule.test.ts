import { describe, it, expect } from "vitest";
import { recapDueAt, recapEligible, recapStillWanted } from "@/lib/recaps/schedule";
import { planRecaps } from "@/lib/recaps/tick";
import { backupNights, deployFacts } from "@/lib/recaps/collect";

const base = { parentAppId: null, isSystemManaged: false, orgIsSystemManaged: false, environmentType: null, groupEnvironmentId: null };

describe("recapDueAt", () => {
  it("sends at 09:00 on the day the 72 hours run out", () => {
    expect(recapDueAt(new Date("2026-10-13T08:00:00Z"), "72h").toISOString()).toBe("2026-10-16T09:00:00.000Z");
  });

  it("waits for the next morning when 72 hours end after 09:00", () => {
    expect(recapDueAt(new Date("2026-10-13T15:30:00Z"), "72h").toISOString()).toBe("2026-10-17T09:00:00.000Z");
  });

  it("uses the org's zone, so recaps due the same local day share a send time", () => {
    const tz = "America/Los_Angeles";
    // 22:00 Oct 12 and 08:00 Oct 13, Pacific.
    const night = recapDueAt(new Date("2026-10-13T05:00:00Z"), "72h", tz);
    const morning = recapDueAt(new Date("2026-10-13T15:00:00Z"), "72h", tz);
    expect(night.toISOString()).toBe("2026-10-16T16:00:00.000Z");
    expect(morning.toISOString()).toBe("2026-10-16T16:00:00.000Z");
    expect(recapDueAt(new Date("2026-10-13T17:00:00Z"), "72h", tz).toISOString()).toBe("2026-10-17T16:00:00.000Z");
  });

  it("puts the 30-day recap 30 days out", () => {
    expect(recapDueAt(new Date("2026-10-13T08:00:00Z"), "30d").toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });
});

describe("recapEligible", () => {
  it("covers a production app", () => {
    expect(recapEligible(base)).toBe(true);
    expect(recapEligible({ ...base, environmentType: "production" })).toBe(true);
  });

  it("skips PR previews, staging and group environments", () => {
    expect(recapEligible({ ...base, environmentType: "preview" })).toBe(false);
    expect(recapEligible({ ...base, environmentType: "staging" })).toBe(false);
    expect(recapEligible({ ...base, groupEnvironmentId: "ge1" })).toBe(false);
  });

  it("skips compose children and Vardo's own services", () => {
    expect(recapEligible({ ...base, parentAppId: "parent" })).toBe(false);
    expect(recapEligible({ ...base, isSystemManaged: true })).toBe(false);
    expect(recapEligible({ ...base, orgIsSystemManaged: true })).toBe(false);
  });
});

describe("recapStillWanted", () => {
  it("drops a recap for a stopped, parked or missing app and keeps one for a crashing app", () => {
    expect(recapStillWanted("active", false)).toBe(true);
    expect(recapStillWanted("error", false)).toBe(true);
    expect(recapStillWanted("stopped", false)).toBe(false);
    expect(recapStillWanted("missing", false)).toBe(false);
    expect(recapStillWanted("active", true)).toBe(false);
  });
});

describe("planRecaps", () => {
  const row = (appId: string, organizationId: string, kind: "72h" | "30d" = "72h", status = "active") => ({
    appId,
    organizationId,
    kind,
    deployedAt: new Date("2026-10-13T08:00:00Z"),
    status,
    parked: false,
  });

  it("groups due recaps by org", () => {
    const plan = planRecaps([row("a", "o1"), row("b", "o1"), row("c", "o2", "30d")]);
    expect([...plan.send.keys()]).toEqual(["o1", "o2"]);
    expect(plan.send.get("o1")!.map((r) => r.appId)).toEqual(["a", "b"]);
  });

  it("stops recaps for apps that were stopped", () => {
    const plan = planRecaps([row("a", "o1", "72h", "stopped"), row("b", "o1")]);
    expect(plan.stop.map((r) => r.appId)).toEqual(["a"]);
    expect(plan.send.get("o1")!.map((r) => r.appId)).toEqual(["b"]);
  });

  it("lets a 30-day recap stand in for a 72-hour one still pending", () => {
    const plan = planRecaps([row("a", "o1", "72h"), row("a", "o1", "30d")]);
    expect(plan.skip.map((r) => r.kind)).toEqual(["72h"]);
    expect(plan.send.get("o1")!.map((r) => r.kind)).toEqual(["30d"]);
  });
});

describe("deployFacts", () => {
  const deployedAt = new Date("2026-10-13T08:00:00Z");
  const timings = (ms: number) => ({ build: { startedAt: "", endedAt: "", ms } });

  it("counts finished deploys, failures and build times", () => {
    const rows = [
      { status: "success", startedAt: deployedAt, stageTimings: timings(120_000) },
      { status: "success", startedAt: new Date("2026-10-14T08:00:00Z"), stageTimings: timings(100_000) },
      { status: "failed", startedAt: new Date("2026-10-14T09:00:00Z"), stageTimings: null },
      { status: "cancelled", startedAt: new Date("2026-10-14T10:00:00Z"), stageTimings: null },
    ];
    const facts = deployFacts(rows, { kind: "72h", deployedAt, since: deployedAt, until: new Date("2026-10-16T09:00:00Z"), tz: "UTC" });
    expect(facts.deploys).toEqual({ total: 3, failed: 1 });
    expect(facts.build).toEqual({ avgMs: 110_000, fastestMs: 100_000 });
    expect(facts.deploysByDay).toBeUndefined();
  });

  it("reads a prebuilt image as no build", () => {
    const facts = deployFacts([{ status: "success", startedAt: deployedAt, stageTimings: null }], { kind: "72h", deployedAt, since: deployedAt, until: deployedAt, tz: "UTC" });
    expect(facts.build).toBeNull();
  });

  it("charts a month by day and compares builds with the first three days", () => {
    const until = new Date("2026-11-12T09:00:00Z");
    const rows = [
      { status: "success", startedAt: deployedAt, stageTimings: timings(60_000) },
      { status: "failed", startedAt: new Date("2026-10-20T10:00:00Z"), stageTimings: null },
      { status: "success", startedAt: new Date("2026-10-20T11:00:00Z"), stageTimings: timings(120_000) },
    ];
    const facts = deployFacts(rows, { kind: "30d", deployedAt, since: deployedAt, until, tz: "UTC" });
    expect(facts.deploysByDay).toHaveLength(31);
    expect(facts.deploysByDay![7]).toEqual({ succeeded: 1, failed: 1 });
    expect(facts.build).toEqual({ avgMs: 90_000, fastestMs: 60_000, earlyAvgMs: 60_000 });
  });
});

describe("backupNights", () => {
  it("marks each local day ran, failed or nothing", () => {
    const since = new Date("2026-10-13T08:00:00Z");
    const until = new Date("2026-10-16T09:00:00Z");
    const nights = backupNights(
      [
        { status: "success", startedAt: new Date("2026-10-13T09:00:00Z") },
        { status: "failed", startedAt: new Date("2026-10-14T02:00:00Z") },
        { status: "failed", startedAt: new Date("2026-10-16T02:00:00Z") },
        { status: "success", startedAt: new Date("2026-10-16T03:00:00Z") },
      ],
      since,
      until,
      "UTC",
    );
    expect(nights).toEqual(["ok", "fail", "none", "ok"]);
  });
});
