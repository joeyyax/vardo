import { describe, expect, it } from "vitest";
import { anomalyItem, newPortItem, newProcessItem, type Finding } from "@/lib/anomaly/items";

const app = { id: "a1", name: "plex" };
const since = Date.UTC(2026, 9, 13, 12, 0);

describe("newPortItem", () => {
  it("states the fact for one port", () => {
    const item = newPortItem(app, ["tcp/8080"], since, null);
    expect(item.title).toBe("plex opened tcp/8080 without a deploy");
    expect(item.detail).toBe(
      "plex hasn't listened on this port before, and nothing was deployed or changed in Vardo around then. If you changed its settings yourself, there's nothing to do.",
    );
    expect(item.facts).toEqual([{ label: "Port", value: "tcp/8080" }]);
  });

  it("counts several ports", () => {
    const item = newPortItem(app, ["tcp/8080", "tcp/8081", "udp/1900"], since, null);
    expect(item.title).toBe("plex opened 3 new ports without a deploy");
    expect(item.detail).toContain("hasn't listened on these ports before");
    expect(item.facts).toEqual([{ label: "Ports", value: "tcp/8080, tcp/8081, udp/1900" }]);
  });
});

describe("newProcessItem", () => {
  const formbricks = { id: "a2", name: "formbricks" };

  it("names the one process", () => {
    const item = newProcessItem(formbricks, ["worker"], since, [{ pid: 1, name: "node", cpu: 12, rssKb: 1 }]);
    expect(item.title).toBe("formbricks started a new process, worker, without a deploy");
    expect(item.detail).toContain("formbricks hasn't run this process before");
    expect(item.facts).toEqual([
      { label: "Process", value: "worker" },
      { label: "Top processes", value: "node 12% CPU" },
    ]);
  });

  it("counts several processes", () => {
    expect(newProcessItem(formbricks, ["worker", "cron"], since, null).title).toBe("formbricks started 2 new processes without a deploy");
  });
});

describe("anomalyItem", () => {
  const wha = { id: "a3", name: "WHA Staging" };
  const MiB = 1024 ** 2;
  const finding = (signal: Finding["signal"], fires: boolean, value: number, typical: number, threshold: number, severity: "warning" | "critical" = "warning"): Finding => ({
    signal,
    verdict: { fires, holds: true, severity, value, since, line: { typical, high: typical, threshold, clearBelow: threshold * 0.75 } },
    recent: [value],
  });
  // jy0, 2026-10-15: pids fired while egress and CPU only held, both at or under typical.
  const findings = [
    finding("egress", false, 4.7, (11.3 * MiB) / 60, 1_701_460),
    finding("cpu", false, 0, 0, 5),
    finding("pids", true, 16, 0, 10),
  ];

  it("leads with the signal that fired", () => {
    const item = anomalyItem(wha, findings, null);
    expect(item.title).toBe("WHA Staging is running more processes than usual");
    expect(item.severity).toBe("warning");
    expect(item.view?.brief?.body).toBe("Running 16, against a usual 0 for this hour.");
    expect(item.series?.title).toBe("Processes, last hour");
  });

  it("leaves out holding signals that aren't above typical", () => {
    const item = anomalyItem(wha, findings, null);
    expect(item.facts).toEqual([{ label: "Processes", value: "16 now, typically 0" }]);
    expect(item.view?.lead?.[0]).not.toContain("is up too");
    expect(item.detail).not.toContain("outbound traffic");
  });

  it("keeps a holding signal that is still up", () => {
    const item = anomalyItem(wha, [finding("egress", false, (40 * MiB) / 60, (11.3 * MiB) / 60, 1_701_460), ...findings.slice(1)], null);
    expect(item.title).toBe("WHA Staging is running more processes than usual");
    expect(item.facts?.map((f) => f.label)).toEqual(["Processes", "Outbound traffic"]);
  });

  it("leads with the first holding signal when none fires", () => {
    const item = anomalyItem(wha, [finding("egress", false, (40 * MiB) / 60, (11.3 * MiB) / 60, 1_701_460), finding("cpu", false, 0, 0, 5)], null);
    expect(item.title).toBe("WHA Staging is sending more traffic than usual");
    expect(item.severity).toBe("warning");
    expect(item.facts?.map((f) => f.label)).toEqual(["Outbound traffic"]);
  });

  it("says what happened on a modest rise in outbound traffic, without calling it a compromise", () => {
    const item = anomalyItem(wha, [finding("egress", true, (120 * MiB) / 60, (11.3 * MiB) / 60, 1_701_460)], null);
    expect(item.title).toBe("WHA Staging is sending more traffic than usual");
    expect(item.detail).toBe("It's above its own normal for this time of day. If nothing explains it, check its logs, recent deploys and running processes.");
    expect(item.view?.lead?.[0]).toBe("Sending 120 MiB/min, against a usual 11.3 MiB/min for this hour. If nothing explains it, check its logs, recent deploys and running processes.");
  });

  it("says far more only when it's critical", () => {
    const item = anomalyItem(wha, [finding("egress", true, (400 * MiB) / 60, (11.3 * MiB) / 60, 1_701_460, "critical")], null);
    expect(item.title).toBe("WHA Staging is sending far more traffic than usual");
    expect(item.detail).toMatch(/^It's well above its own normal/);
  });

  it("carries a start bounded by the readings held", () => {
    const bounded = (f: Finding): Finding => ({ ...f, verdict: { ...f.verdict, sinceAtLeast: true } });
    expect(anomalyItem(wha, [bounded(findings[2])], null).sinceAtLeast).toBe(true);
    expect(anomalyItem(wha, [findings[2]], null).sinceAtLeast).toBeUndefined();
  });

  it("names a new top process as new", () => {
    const top = [{ pid: 1, name: "kworkerd", cpu: 187, rssKb: 1 }];
    const lead = (fresh: string[]) => anomalyItem(wha, [finding("cpu", true, 190, 4, 27)], top, fresh).view?.lead?.[0];
    expect(lead(["kworkerd"])).toContain("A process called kworkerd is using 1.9 cores, and it hasn't run in this app before.");
    expect(lead([])).toContain("A process called kworkerd is using 1.9 cores.");
  });
});
