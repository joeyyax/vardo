// #898: saving system storage updates the existing system target and refuses what it can't merge.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureSystemBackup, setSystemSetting, update, set, findFirst, file } = vi.hoisted(() => ({
  ensureSystemBackup: vi.fn(),
  setSystemSetting: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  findFirst: vi.fn(),
  file: { backup: undefined as unknown },
}));

vi.mock("@/lib/system-settings", () => ({ getBackupStorageConfig: async () => null, setSystemSetting }));
vi.mock("@/lib/backups/auto-backup", () => ({ ensureSystemBackup }));
vi.mock("@/lib/config/vardo-config", () => ({ readVardoConfig: async () => file }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/backups/target-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/backups/target-config")>()),
  sealTargetConfig: (c: unknown) => c,
}));
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where"]) chain[m] = () => chain;
  chain.limit = async () => [];
  return {
    db: {
      select: () => chain,
      query: { backupTargets: { findFirst } },
      update: (t: unknown) => {
        update(t);
        return { set: (v: unknown) => { set(v); return { where: async () => {} }; } };
      },
    },
  };
});

const { saveSystemBackupStorage, SystemStorageConflict } = await import("@/lib/backups/system-storage");

const input = { type: "s3" as const, bucket: "new", region: "auto", accessKey: "__MASKED__:abcd", secretKey: "fresh" };

beforeEach(() => {
  vi.clearAllMocks();
  file.backup = undefined;
  ensureSystemBackup.mockResolvedValue(null);
  findFirst.mockResolvedValue(undefined);
});

describe("saveSystemBackupStorage", () => {
  it("updates the existing system target and keeps a masked credential", async () => {
    findFirst.mockResolvedValue({
      id: "t1",
      name: "System default",
      type: "s3",
      config: { bucket: "old", region: "auto", accessKeyId: "enc:a", secretAccessKey: "enc:s" },
    });

    await saveSystemBackupStorage(input);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "s3",
        config: { bucket: "new", region: "auto", accessKeyId: "enc:a", secretAccessKey: "fresh" },
      }),
    );
    expect(ensureSystemBackup).toHaveBeenCalledTimes(1);
  });

  it("leaves targets alone when none exists yet", async () => {
    await saveSystemBackupStorage(input);

    expect(set).not.toHaveBeenCalled();
    expect(setSystemSetting).toHaveBeenCalled();
    expect(ensureSystemBackup).toHaveBeenCalledTimes(1);
  });

  it("refuses when vardo.yml owns the storage", async () => {
    file.backup = { type: "s3" };

    await expect(saveSystemBackupStorage(input)).rejects.toBeInstanceOf(SystemStorageConflict);
    expect(setSystemSetting).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a non-S3 system target", async () => {
    findFirst.mockResolvedValue({ id: "t2", name: "Offsite", type: "ssh", config: {} });

    await expect(saveSystemBackupStorage(input)).rejects.toBeInstanceOf(SystemStorageConflict);
    expect(setSystemSetting).not.toHaveBeenCalled();
  });
});
