// The worker's backup loops wait for web's record of this release's credential encryption and backup target.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntervalLoop } from "@/lib/worker/interval-loop";

const store = vi.hoisted(() => ({ rows: new Map<string, { value: string; updatedAt: Date }>(), failReads: false }));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/version", () => ({ getBuildSha: () => "abc1234" }));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (_col: unknown, value: unknown) => ({ eq: value }),
  ne: (_col: unknown, value: unknown) => ({ ne: value }),
  like: (_col: unknown, value: unknown) => ({ like: value }),
  lt: (_col: unknown, value: unknown) => ({ lt: value }),
  and: (...parts: unknown[]) => ({ and: parts }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (row: { key: string; value: string; updatedAt: Date }) => ({
        onConflictDoUpdate: async () => void store.rows.set(row.key, { value: row.value, updatedAt: row.updatedAt }),
      }),
    }),
    delete: () => ({
      where: async (w: { and: [{ like: string }, { ne: string }, { lt: Date }] }) => {
        const [, { ne }, { lt }] = w.and;
        for (const [key, row] of store.rows) if (key.startsWith("backup_boot:") && key !== ne && row.updatedAt < lt) store.rows.delete(key);
      },
    }),
    query: {
      systemSettings: {
        findFirst: async ({ where }: { where: { eq: string } }) => {
          if (store.failReads) throw new Error("connection refused");
          return store.rows.has(where.eq) ? { key: where.eq } : undefined;
        },
      },
    },
  },
}));

const { backupBootKey, recordBackupBoot, waitForBackupBoot } = await import("@/lib/backups/boot-gate");
const { startLoops } = await import("@/lib/worker/start");

beforeEach(() => {
  store.rows.clear();
  store.failReads = false;
});

describe("recordBackupBoot", () => {
  it("records this release with what credential encryption did", async () => {
    await recordBackupBoot("encrypted");
    expect(JSON.parse(store.rows.get("backup_boot:abc1234")!.value)).toMatchObject({ credentials: "encrypted" });
  });

  it("drops records of releases older than 90 days", async () => {
    store.rows.set("backup_boot:old", { value: "{}", updatedAt: new Date(Date.now() - 100 * 24 * 60 * 60_000) });
    store.rows.set("backup_boot:recent", { value: "{}", updatedAt: new Date(Date.now() - 24 * 60 * 60_000) });
    await recordBackupBoot("skipped");
    expect([...store.rows.keys()].sort()).toEqual(["backup_boot:abc1234", "backup_boot:recent"]);
  });

  it("names a build without a SHA", () => {
    expect(backupBootKey("")).toBe("backup_boot:dev");
  });
});

describe("waitForBackupBoot", () => {
  it("resolves once web records this release, not an older one", async () => {
    store.rows.set("backup_boot:0ld0000", { value: "{}", updatedAt: new Date() });
    let done = false;
    const waiting = waitForBackupBoot({ stopped: () => false, pollMs: 5 }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    await recordBackupBoot("encrypted");
    await waiting;
    expect(done).toBe(true);
  });

  it("keeps waiting through a database error", async () => {
    store.failReads = true;
    let done = false;
    const waiting = waitForBackupBoot({ stopped: () => false, pollMs: 5 }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    store.failReads = false;
    await recordBackupBoot("encrypted");
    await waiting;
  });

  it("rejects when the worker stops first", async () => {
    let stopped = false;
    const waiting = waitForBackupBoot({ stopped: () => stopped, pollMs: 5 });
    stopped = true;
    await expect(waiting).rejects.toThrow(/Stopped/);
  });
});

describe("the worker's backup loops", () => {
  const backupLoop = (start: () => void) => ({
    name: "backup-tick",
    roles: ["worker" as const],
    singleton: true,
    after: "backup-target" as const,
    load: async () => ({ name: "backup-tick", start }) as unknown as IntervalLoop,
  });

  it("don't start before credential encryption is recorded", async () => {
    const start = vi.fn();
    const gate = waitForBackupBoot({ stopped: () => false, pollMs: 5 });
    const starting = startLoops({ role: "worker", ready: { "backup-target": gate }, registry: [backupLoop(start)] });
    await new Promise((r) => setTimeout(r, 30));
    expect(start).not.toHaveBeenCalled();
    await recordBackupBoot("encrypted");
    await starting;
    expect(start).toHaveBeenCalledOnce();
  });

  it("never start when the worker stops while waiting", async () => {
    const start = vi.fn();
    let stopped = false;
    const gate = waitForBackupBoot({ stopped: () => stopped, pollMs: 5 });
    gate.catch(() => {});
    const starting = startLoops({ role: "worker", ready: { "backup-target": gate }, registry: [backupLoop(start)] });
    stopped = true;
    await starting;
    expect(start).not.toHaveBeenCalled();
  });
});
