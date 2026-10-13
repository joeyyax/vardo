import { describe, expect, it } from "vitest";
import { newPortItem, newProcessItem } from "@/lib/anomaly/items";

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
