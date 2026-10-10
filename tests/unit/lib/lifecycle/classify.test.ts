import { describe, it, expect } from "vitest";
import {
  classifyBoot,
  markSeen,
  missingContainers,
  parseBtime,
  parseUpdateMarker,
  updateAnnouncement,
  type Heartbeat,
  type UpdateMarker,
} from "@/lib/lifecycle/classify";

const HOST_BOOT = Date.parse("2026-09-01T00:00:00Z");
const NOW = Date.parse("2026-10-09T17:00:00Z");

const heartbeat = (at: number, hostBootAt = HOST_BOOT): Heartbeat => ({ at, hostBootAt, version: "0.1.0 (e36c2e3)" });

describe("classifyBoot", () => {
  it("says nothing on the first boot", () => {
    expect(classifyBoot({ heartbeat: null, shutdown: null, hostBootAt: HOST_BOOT, startedAt: NOW })).toEqual({ kind: "first-boot" });
  });

  it("sees a clean console restart", () => {
    const boot = classifyBoot({
      heartbeat: heartbeat(NOW - 40_000),
      shutdown: { at: NOW - 20_000, reason: "vardo update", version: "x" },
      hostBootAt: HOST_BOOT,
      startedAt: NOW,
    });
    expect(boot).toEqual({ kind: "clean", downSeconds: 20, hostRebooted: false, reason: "vardo update" });
  });

  it("sees a host reboot from a new boot time", () => {
    // A 2026-10-09 reboot: SIGTERM, 149 s down, new btime.
    const boot = classifyBoot({
      heartbeat: heartbeat(NOW - 160_000),
      shutdown: { at: NOW - 149_000, reason: "Stop signal", version: "x" },
      hostBootAt: NOW - 90_000,
      startedAt: NOW,
    });
    expect(boot).toMatchObject({ kind: "clean", downSeconds: 149, hostRebooted: true });
  });

  it("calls a stop without a marker unclean", () => {
    const boot = classifyBoot({ heartbeat: heartbeat(NOW - 412_000), shutdown: null, hostBootAt: NOW - 300_000, startedAt: NOW });
    expect(boot).toEqual({
      kind: "unclean",
      downSeconds: 412,
      hostRebooted: true,
      lastHeartbeatAt: new Date(NOW - 412_000).toISOString(),
    });
  });

  it("ignores a marker from an earlier run", () => {
    const boot = classifyBoot({
      heartbeat: heartbeat(NOW - 60_000),
      shutdown: { at: NOW - 3_600_000, reason: "old", version: "x" },
      hostBootAt: HOST_BOOT,
      startedAt: NOW,
    });
    expect(boot.kind).toBe("unclean");
  });

  it("tolerates boot time jitter", () => {
    const boot = classifyBoot({
      heartbeat: heartbeat(NOW - 40_000),
      shutdown: { at: NOW - 20_000, reason: "stop", version: "x" },
      hostBootAt: HOST_BOOT + 2_000,
      startedAt: NOW,
    });
    expect(boot).toMatchObject({ hostRebooted: false });
  });
});

describe("parseBtime", () => {
  it("reads the host boot time from /proc/stat", () => {
    expect(parseBtime("cpu  1 2 3\nbtime 1791565200\nprocesses 10\n")).toBe(1791565200_000);
    expect(parseBtime("cpu 1 2 3\n")).toBeNull();
  });
});

describe("update markers", () => {
  const started: UpdateMarker = {
    id: "20261009170000-1234",
    state: "started",
    startedAt: NOW - 200_000,
    fromVersion: "e36c2e3",
    branch: "main",
    fromSlot: "blue",
    toSlot: "green",
  };
  const updated: UpdateMarker = { ...started, state: "updated", toVersion: "4f1a9b2", finishedAt: NOW - 5_000 };
  const failed: UpdateMarker = { ...started, state: "failed", step: "Health check", rolledBack: true, finishedAt: NOW - 5_000 };

  it("parses what install.sh writes, in epoch seconds", () => {
    const marker = parseUpdateMarker(
      JSON.stringify({
        id: "20261009170000-1234",
        state: "failed",
        startedAt: 1791565200,
        finishedAt: 1791565501,
        fromVersion: "e36c2e3",
        toVersion: "4f1a9b2",
        step: "Health check",
        error: "New frontend did not become healthy",
        rolledBack: true,
        logTail: ["a", "b"],
      }),
    );
    expect(marker).toMatchObject({ state: "failed", startedAt: 1791565200_000, finishedAt: 1791565501_000, rolledBack: true, logTail: ["a", "b"] });
    expect(parseUpdateMarker("{not json")).toBeNull();
    expect(parseUpdateMarker(JSON.stringify({ id: "x", state: "weird", startedAt: 1 }))).toBeNull();
  });

  it("announces each state once", () => {
    expect(updateAnnouncement(started, null, NOW)).toBe("started");
    const seen = markSeen(null, started, "started");
    expect(updateAnnouncement(started, seen, NOW)).toBeNull();
    expect(updateAnnouncement(updated, seen, NOW)).toBe("updated");
    expect(updateAnnouncement(updated, markSeen(seen, updated, "updated"), NOW)).toBeNull();
  });

  it("announces a failure after the start", () => {
    expect(updateAnnouncement(failed, markSeen(null, started, "started"), NOW)).toBe("failed");
  });

  it("treats a new run as new", () => {
    const next = { ...started, id: "20261010090000-99" };
    expect(updateAnnouncement(next, markSeen(null, updated, "updated"), NOW)).toBe("started");
  });

  it("ignores stale markers", () => {
    expect(updateAnnouncement(updated, null, NOW + 2 * 24 * 60 * 60 * 1000)).toBeNull();
  });
});

describe("missingContainers", () => {
  const before = [
    { id: "a", name: "acme-web-production-green-web-1", app: "acme-web" },
    { id: "b", name: "search-data-production-green-meilisearch-1", app: "search-data" },
    { id: "c", name: "shop-production-blue-web-1", app: "shop" },
    { id: "d", name: "gone-1" },
  ];

  it("reports containers that should be running and aren't", () => {
    const missing = missingContainers(before, [
      { id: "a", state: "running" },
      { id: "b", state: "exited", restartPolicy: "unless-stopped" },
      { id: "c", state: "exited", restartPolicy: "no" },
    ]);
    expect(missing).toEqual([{ id: "b", name: "search-data-production-green-meilisearch-1", app: "search-data", state: "exited" }]);
  });
});
