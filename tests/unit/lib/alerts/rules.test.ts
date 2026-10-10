import { describe, expect, it } from "vitest";
import { judgeThreshold, type Point } from "@/lib/alerts/threshold";
import { HOST_RULES, HostSampleBuffer, hostObservations, parseMeminfo, type HostSample } from "@/lib/alerts/host";
import { conditionObservations, UNHEALTHY_ALERT_MS } from "@/lib/alerts/apps";
import { oomObservation, recentOomKills, recordOomKill, resetOomKills, OOM_HOLD_MS } from "@/lib/alerts/oom";

const MIN = 60_000;
const now = 10 * 60 * MIN;
const rule = { warn: 85, critical: 95, clearBelow: 80, sustainMs: 5 * MIN };

/** One reading a minute, ending at `now`. */
function minutes(values: number[]): Point[] {
  return values.map((value, i) => ({ at: now - (values.length - 1 - i) * MIN, value }));
}

describe("judgeThreshold", () => {
  it("says nothing without a fresh reading", () => {
    expect(judgeThreshold([], rule, now)).toBeNull();
    expect(judgeThreshold([{ at: now - 10 * MIN, value: 99 }], rule, now)).toBeNull();
  });

  it("fires only once the whole window is over the line", () => {
    expect(judgeThreshold(minutes([70, 90, 90, 90, 90, 90]), rule, now)?.fires).toBe(true);
    expect(judgeThreshold(minutes([90, 90, 80, 90, 90, 90]), rule, now)?.fires).toBe(false);
  });

  it("ignores a spike shorter than the minimum duration", () => {
    const verdict = judgeThreshold(minutes([40, 40, 40, 40, 99, 99]), rule, now);
    expect(verdict?.fires).toBe(false);
    expect(verdict?.holds).toBe(true);
  });

  it("can't fire until readings cover the window, as after a restart", () => {
    expect(judgeThreshold(minutes([99, 99]), rule, now)?.fires).toBe(false);
  });

  it("holds above the clear line and lets go below it", () => {
    expect(judgeThreshold(minutes([90, 90, 90, 90, 90, 82]), rule, now)).toMatchObject({ fires: false, holds: true });
    expect(judgeThreshold(minutes([90, 90, 90, 90, 90, 79]), rule, now)).toMatchObject({ fires: false, holds: false });
  });

  it("is critical only when the whole window is critical", () => {
    expect(judgeThreshold(minutes([96, 96, 96, 96, 96, 96]), rule, now)?.severity).toBe("critical");
    expect(judgeThreshold(minutes([96, 96, 90, 96, 96, 96]), rule, now)?.severity).toBe("warning");
  });

  it("fires at once when the window is waived", () => {
    expect(judgeThreshold(minutes([99]), rule, now, { waiveSustain: true })?.fires).toBe(true);
  });
});

function sample(at: number, memory: number): HostSample {
  return {
    at,
    memory: { percent: memory, used: memory, total: 100 },
    swap: null,
    cpuPercent: null,
    load: { avg5: 1, cores: 4, ratio: 0.25 },
    disk: { percent: 50, used: 50, total: 100 },
  };
}

describe("hostObservations", () => {
  it("leaves out types with no reading so they neither fire nor clear", () => {
    const buffer = new HostSampleBuffer();
    buffer.push(sample(now, 50));
    const { evaluated } = hostObservations(buffer, now, {});
    expect(evaluated).toEqual(expect.arrayContaining(["host.memory", "host.load", "host.disk"]));
    expect(evaluated).not.toContain("host.swap");
    expect(evaluated).not.toContain("host.cpu");
  });

  it("fires memory after the sustained window with the top containers named", () => {
    const buffer = new HostSampleBuffer();
    for (let i = 6; i >= 0; i--) buffer.push(sample(now - i * MIN, 91));
    const { observations } = hostObservations(buffer, now, { topMemory: [{ name: "shop", bytes: 2 ** 30 }] });
    const memory = observations.find((o) => o.type === "host.memory")!;
    expect(memory.fires).toBe(true);
    expect(memory.item.title).toBe("Memory 91% used");
    expect(memory.item.facts?.find((f) => f.label === "Top containers")?.value).toContain("shop");
  });

  it("lets a host OOM kill confirm memory pressure early", () => {
    const buffer = new HostSampleBuffer();
    buffer.push(sample(now, 91));
    expect(hostObservations(buffer, now, {}).observations.find((o) => o.type === "host.memory")?.fires).toBe(false);
    expect(hostObservations(buffer, now, {}, { memoryConfirmed: true }).observations.find((o) => o.type === "host.memory")?.fires).toBe(true);
  });

  it("uses MemAvailable, not free memory", () => {
    const info = parseMeminfo("MemTotal:  1000 kB\nMemFree:  100 kB\nMemAvailable:  600 kB\nSwapTotal: 0 kB\n");
    expect(info.MemAvailable).toBe(600 * 1024);
  });

  it("has a clear line under every alert line", () => {
    for (const r of Object.values(HOST_RULES)) expect(r.clearBelow).toBeLessThan(r.warn);
  });
});

const app = (conditions: Parameters<typeof conditionObservations>[0]["conditions"]) => ({ id: "app1", name: "Shop", organizationId: "org1", conditions });

describe("conditionObservations", () => {
  it("waits before calling a failing health check stuck", () => {
    const fresh = conditionObservations(app([{ kind: "unhealthy", severity: "warning", since: new Date(now - MIN).toISOString(), detail: "" }]), now);
    expect(fresh[0]).toMatchObject({ type: "app.unhealthy", fires: false });
    const stuck = conditionObservations(app([{ kind: "unhealthy", severity: "warning", since: new Date(now - UNHEALTHY_ALERT_MS).toISOString(), detail: "" }]), now);
    expect(stuck[0]).toMatchObject({ type: "app.unhealthy", fires: true });
  });

  it("maps restart loops and memory pressure", () => {
    const obs = conditionObservations(
      app([
        { kind: "crash-looping", severity: "critical", since: new Date(now).toISOString(), detail: "4 restarts in 5m, never healthy" },
        { kind: "memory-pressure", severity: "warning", since: new Date(now).toISOString(), detail: "93% of memory limit" },
      ]),
      now,
    );
    expect(obs.map((o) => o.type)).toEqual(["app.restart-loop", "app.memory-limit"]);
    expect(obs[1].item.gauge?.percent).toBe(93);
  });
});

describe("OOM kills", () => {
  it("rolls kills of one app into one subject and drops them after the hold", () => {
    resetOomKills();
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c1", kind: "oom-host" }, now);
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c1", kind: "oom-limit" }, now + MIN);
    const [record] = recentOomKills(now + MIN);
    expect(record).toMatchObject({ kills: 2, hostKill: true });
    expect(oomObservation(record).item.facts).toContainEqual({ label: "Container", value: "c1 (2)" });
    expect(recentOomKills(now + MIN + OOM_HOLD_MS + 1)).toEqual([]);
  });
});
