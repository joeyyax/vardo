import { describe, expect, it } from "vitest";
import {
  archivesAsOf,
  backupTimeFromKey,
  checkKeyIds,
  moveToFront,
  nextRunnable,
  orderQueue,
  progressOf,
  systemBackupsFrom,
  type QueueItem,
  type QueueUnit,
} from "@/lib/restore/plan";

describe("systemBackupsFrom", () => {
  it("keeps only system dumps, newest first, dated from the key", () => {
    const found = systemBackupsFrom([
      { key: "vardo-system/postgres/2026-10-01T03-12-00-000Z.dump.gz", sizeBytes: 10, modifiedAt: new Date(0) },
      { key: "vardo-system/postgres/2026-10-07T03-12-00-000Z.dump.gz", sizeBytes: 20, modifiedAt: new Date(0) },
      { key: "acme/web/data/2026-10-08T01-00-00-000Z.tar.gz", sizeBytes: 30, modifiedAt: new Date(0) },
      { key: "vardo-system/postgres/notes.txt", sizeBytes: 1, modifiedAt: new Date(0) },
    ]);
    expect(found.map((b) => b.key)).toEqual([
      "vardo-system/postgres/2026-10-07T03-12-00-000Z.dump.gz",
      "vardo-system/postgres/2026-10-01T03-12-00-000Z.dump.gz",
    ]);
    expect(found[0].takenAt.toISOString()).toBe("2026-10-07T03:12:00.000Z");
  });

  it("reads the timestamp the engine writes", () => {
    const ts = new Date("2026-10-08T04:05:06.789Z").toISOString().replace(/[:.]/g, "-");
    expect(backupTimeFromKey(`vardo-system/postgres/${ts}.dump.gz`)?.toISOString()).toBe("2026-10-08T04:05:06.789Z");
  });
});

describe("checkKeyIds", () => {
  it("blocks a key the archive wasn't written with", () => {
    expect(checkKeyIds({ archiveKeyId: "k1:aaaa", enteredKeyId: "k1:bbbb", runningKeyId: "k1:bbbb" }).kind).toBe("wrong-key");
  });

  it("asks to load the key when the instance runs a different one", () => {
    expect(checkKeyIds({ archiveKeyId: "k1:aaaa", enteredKeyId: "k1:aaaa", runningKeyId: "k1:cccc" }).kind).toBe("not-loaded");
  });

  it("matches when all three agree", () => {
    expect(checkKeyIds({ archiveKeyId: "k1:aaaa", enteredKeyId: "k1:aaaa", runningKeyId: "k1:aaaa" }).kind).toBe("match");
  });

  it("calls out a plaintext archive", () => {
    expect(checkKeyIds({ archiveKeyId: null, enteredKeyId: "k1:aaaa", runningKeyId: "k1:aaaa" }).kind).toBe("unencrypted");
  });
});

describe("archivesAsOf", () => {
  const row = (id: string, finishedAt: string, volumeName = "data") => ({
    id,
    appId: "app-1",
    appName: "web",
    volumeName,
    strategy: "tar" as const,
    finishedAt: new Date(finishedAt),
  });

  it("takes the newest archive at or before the system backup, not after it", () => {
    const picked = archivesAsOf(
      [row("old", "2026-10-06T02:00:00Z"), row("at", "2026-10-07T03:12:00Z"), row("later", "2026-10-07T04:00:00Z")],
      new Date("2026-10-07T03:12:00Z"),
    );
    expect(picked.get("app-1:data")?.map((r) => r.id)).toEqual(["at", "old"]);
  });

  it("keeps volumes apart", () => {
    const picked = archivesAsOf(
      [row("a", "2026-10-06T02:00:00Z", "data"), row("b", "2026-10-06T02:00:00Z", "db")],
      new Date("2026-10-07T00:00:00Z"),
    );
    expect([...picked.keys()].sort()).toEqual(["app-1:data", "app-1:db"]);
  });
});

describe("orderQueue", () => {
  const unit = (appId: string, priority: QueueUnit["priority"], dependsOn: string[] = []): QueueUnit => ({
    appId,
    name: appId,
    projectId: "p1",
    priority,
    dependsOn,
  });

  it("puts critical apps first and disposable apps last", () => {
    const order = orderQueue([unit("toys", "disposable"), unit("web", "standard"), unit("nvr", "critical")]);
    expect(order.map((o) => o.appId)).toEqual(["nvr", "web", "toys"]);
  });

  it("puts a dependency before its dependent within a priority", () => {
    const order = orderQueue([unit("api", "standard", ["db"]), unit("db", "standard")]);
    expect(order.map((o) => o.appId)).toEqual(["db", "api"]);
    expect(order[1].dependsOn).toEqual(["db"]);
  });

  it("pulls a standard dependency up with the critical app that needs it", () => {
    const order = orderQueue([unit("alpha", "standard"), unit("db", "standard"), unit("nvr", "critical", ["db"])]);
    expect(order.map((o) => o.appId)).toEqual(["db", "nvr", "alpha"]);
  });

  it("ignores dependencies in other projects", () => {
    const other = { ...unit("db", "standard"), projectId: "p2" };
    expect(orderQueue([unit("api", "standard", ["db"]), other])[0].dependsOn).toEqual([]);
  });
});

describe("nextRunnable", () => {
  const item = (appId: string, position: number, extra: Partial<QueueItem> = {}): QueueItem => ({
    appId,
    position,
    status: "queued",
    weight: 1,
    dependsOn: [],
    ...extra,
  });

  it("fills the budget in queue order", () => {
    const picked = nextRunnable([item("a", 0), item("b", 1), item("c", 2), item("d", 3)], 3);
    expect(picked.map((i) => i.appId)).toEqual(["a", "b", "c"]);
  });

  it("counts a build as two", () => {
    const picked = nextRunnable([item("a", 0, { weight: 2 }), item("b", 1), item("c", 2)], 3);
    expect(picked.map((i) => i.appId)).toEqual(["a", "b"]);
  });

  it("counts apps already in flight", () => {
    const picked = nextRunnable([item("a", 0, { status: "deploying", weight: 2 }), item("b", 1), item("c", 2)], 3);
    expect(picked.map((i) => i.appId)).toEqual(["b"]);
  });

  it("runs a heavy app alone rather than never", () => {
    expect(nextRunnable([item("plex", 0, { weight: 5 })], 3).map((i) => i.appId)).toEqual(["plex"]);
  });

  it("waits for a dependency to settle", () => {
    const picked = nextRunnable([item("db", 0, { status: "restoring" }), item("api", 1, { dependsOn: ["db"] })], 3);
    expect(picked).toEqual([]);
  });

  it("starts a dependent once its dependency failed", () => {
    const picked = nextRunnable([item("db", 0, { status: "failed" }), item("api", 1, { dependsOn: ["db"] })], 3);
    expect(picked.map((i) => i.appId)).toEqual(["api"]);
  });

  it("breaks a dependency cycle instead of stalling", () => {
    const picked = nextRunnable([item("a", 0, { dependsOn: ["b"] }), item("b", 1, { dependsOn: ["a"] })], 3);
    expect(picked.map((i) => i.appId)).toEqual(["a"]);
  });

  it("skips deferred apps", () => {
    expect(nextRunnable([item("plex", 0, { status: "deferred" }), item("web", 1)], 3).map((i) => i.appId)).toEqual(["web"]);
  });
});

describe("moveToFront", () => {
  it("moves the app and its queued dependencies ahead of everything", () => {
    const items: QueueItem[] = [
      { appId: "a", position: 0, status: "queued", weight: 1, dependsOn: [] },
      { appId: "db", position: 1, status: "queued", weight: 1, dependsOn: [] },
      { appId: "b", position: 2, status: "queued", weight: 1, dependsOn: [] },
      { appId: "api", position: 3, status: "queued", weight: 1, dependsOn: ["db"] },
    ];
    const positions = moveToFront(items, "api");
    const order = [...positions.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    expect(order).toEqual(["db", "api", "a", "b"]);
  });
});

describe("progressOf", () => {
  it("counts done, failed and deferred as settled", () => {
    const p = progressOf([
      { status: "done" },
      { status: "failed" },
      { status: "deferred" },
      { status: "restoring" },
      { status: "queued" },
    ]);
    expect(p).toEqual({ total: 5, settled: 3, failed: 1, deferred: 1, active: 1 });
  });
});
