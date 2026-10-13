import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const held = new Map<string, string>();
  return {
    held,
    runBackup: vi.fn(),
    acquireLock: vi.fn(async (key: string) => (held.has(key) ? null : (held.set(key, "t"), "t"))),
    releaseLock: vi.fn(async (key: string) => held.delete(key)),
  };
});

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/redis-lock", () => ({ acquireLock: h.acquireLock, releaseLock: h.releaseLock }));
vi.mock("@/lib/backups/engine", () => ({ MANUAL_TRIGGER: "manual", STALE_RUN_MS: 3_600_000, runBackup: h.runBackup }));

import { dbMock } from "@/tests/helpers/db";
const { startManualBackup } = await import("@/lib/backups/manual-run");

describe("startManualBackup", () => {
  beforeEach(() => {
    dbMock.reset();
    h.held.clear();
    vi.clearAllMocks();
    dbMock.query.backups.findFirst.mockResolvedValue(undefined);
  });

  it("runs a job once when two requests land together", async () => {
    let finish!: () => void;
    h.runBackup.mockReturnValue(new Promise<never[]>((r) => (finish = () => r([]))));
    const [a, b] = await Promise.all([startManualBackup("j1"), startManualBackup("j1")]);
    expect([a.started, b.started].sort()).toEqual([false, true]);
    expect(h.runBackup).toHaveBeenCalledTimes(1);
    expect(h.runBackup).toHaveBeenCalledWith("j1", { trigger: "manual" });

    finish();
    await (a.started ? a.done : b.started ? b.done : null);
    expect((await startManualBackup("j1")).started).toBe(true);
  });

  it("refuses while a backup of the job is running elsewhere", async () => {
    const startedAt = new Date("2026-10-13T21:59:00Z");
    dbMock.query.backups.findFirst.mockResolvedValue({ startedAt });
    expect(await startManualBackup("j1")).toEqual({ started: false, startedAt });
    expect(h.runBackup).not.toHaveBeenCalled();
    expect(h.held.size).toBe(0);
  });

  it("starts anyway with force", async () => {
    h.held.set("lock:backup:manual:j1", "other");
    h.runBackup.mockResolvedValue([]);
    const start = await startManualBackup("j1", { appIds: ["a1"], force: true });
    expect(start.started).toBe(true);
    expect(h.runBackup).toHaveBeenCalledWith("j1", { appIds: ["a1"], trigger: "manual" });
  });
});
