// A self-deploy replaced the console mid-backup and the row stayed `running` for good, with 3.8 GB of staging beside it.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

// Set before the engine computes BACKUPS_DIR at import.
const ROOT = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { tmpdir }, path] = await Promise.all([import("fs"), import("os"), import("path")]);
  const dir = mkdtempSync(path.join(tmpdir(), "vardo-reap-test-"));
  process.env.VARDO_BACKUPS_DIR = dir;
  return dir;
});

const { findMany, updates, held, execMock } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updates: [] as { set: Record<string, unknown> }[],
  held: new Set<string>(),
  execMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { backups: { findMany } },
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ set });
        },
      }),
    }),
  },
}));
vi.mock("@/lib/backups/run-lease", () => ({ backupLeaseHeld: async (id: string) => held.has(id) }));
vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execMock }));
vi.mock("@/lib/docker/client", () => ({ listContainers: vi.fn(), inspectContainer: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { INTERRUPTED_REASON, ORPHAN_STAGING_MS, reapInterruptedBackups, sweepOrphanedStaging } from "@/lib/backups/reap";
import { backupWorkDir } from "@/lib/backups/engine";

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  updates.length = 0;
  held.clear();
  execMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  findMany.mockReset();
});

describe("reapInterruptedBackups", () => {
  it("fails a running row whose lease lapsed, and clears its container and staging", async () => {
    findMany.mockResolvedValue([{ id: "dead", log: "[t] Archiving volume gitea_data" }]);
    mkdirSync(backupWorkDir("dead"), { recursive: true });
    writeFileSync(join(backupWorkDir("dead"), "exclude.list"), "x");

    const reaped = await reapInterruptedBackups(new Date("2026-10-08T00:00:00Z"));

    expect(reaped).toEqual(["dead"]);
    expect(updates).toHaveLength(1);
    expect(updates[0].set.status).toBe("failed");
    expect(updates[0].set.finishedAt).toEqual(new Date("2026-10-08T00:00:00Z"));
    expect(String(updates[0].set.log)).toMatch(/^\[t\] Archiving volume gitea_data\n.*Backup interrupted/);
    expect(String(updates[0].set.log)).toContain(INTERRUPTED_REASON);
    expect(execMock).toHaveBeenCalledWith("docker", ["rm", "-f", "vardo-backup-dead"], expect.anything());
    expect(existsSync(backupWorkDir("dead"))).toBe(false);
  });

  it("spares a row younger than minAgeMs, whose lease may not be taken yet", async () => {
    const now = new Date("2026-10-08T00:10:00Z");
    findMany.mockResolvedValue([
      { id: "fresh", log: null, startedAt: new Date("2026-10-08T00:09:50Z") },
      { id: "old", log: null, startedAt: new Date("2026-10-08T00:05:00Z") },
    ]);

    expect(await reapInterruptedBackups(now, { minAgeMs: 60_000 })).toEqual(["old"]);
  });

  it("leaves a run a live process still holds alone, staging included", async () => {
    findMany.mockResolvedValue([{ id: "live", log: null }]);
    held.add("live");
    mkdirSync(backupWorkDir("live"), { recursive: true });

    const reaped = await reapInterruptedBackups();

    expect(reaped).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(execMock).not.toHaveBeenCalled();
    expect(existsSync(backupWorkDir("live"))).toBe(true);
  });

  it("reaps nothing when Redis can't say who holds what", async () => {
    findMany.mockResolvedValue([{ id: "unknown", log: null }]);
    const lease = await import("@/lib/backups/run-lease");
    vi.spyOn(lease, "backupLeaseHeld").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(reapInterruptedBackups()).rejects.toThrow("ECONNREFUSED");
    expect(updates).toHaveLength(0);
  });
});

describe("sweepOrphanedStaging", () => {
  function stagingDir(name: string, ageMs: number) {
    const dir = join(ROOT, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "volume.tar.gz");
    writeFileSync(file, "x");
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
    utimesSync(dir, when, when);
    return dir;
  }

  it("removes staging nothing has touched for a day and keeps the rest", async () => {
    const stale = stagingDir(".tmp-iNrKXwWq", ORPHAN_STAGING_MS + 60_000);
    const fresh = stagingDir(".tmp-restore-abc", 60_000);
    const other = stagingDir("pre-restore-keep", ORPHAN_STAGING_MS * 3);

    const removed = await sweepOrphanedStaging();

    expect(removed).toEqual([".tmp-iNrKXwWq"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("keeps an old dir whose file is still being written", async () => {
    const dir = stagingDir(".tmp-download-slow", ORPHAN_STAGING_MS * 2);
    writeFileSync(join(dir, "volume.tar.gz"), "still growing");

    expect(await sweepOrphanedStaging()).not.toContain(".tmp-download-slow");
  });
});
