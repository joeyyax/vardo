// #890: saving backup storage during setup creates Vardo's database job.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { ensureSystemBackup, setSystemSetting } = vi.hoisted(() => ({
  ensureSystemBackup: vi.fn(),
  setSystemSetting: vi.fn(),
}));

vi.mock("@/lib/setup-token", () => ({ setupTokenRefusal: async () => null }));
vi.mock("@/lib/setup", () => ({ needsSetup: async () => true }));
vi.mock("@/lib/auth/admin", () => ({ requireAdminAuth: async () => {} }));
vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/system-settings", () => ({
  getBackupStorageConfig: async () => null,
  setSystemSetting,
}));
vi.mock("@/lib/backups/auto-backup", () => ({ ensureSystemBackup }));
vi.mock("@/lib/config/vardo-config", () => ({ readVardoConfig: async () => null }));
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where"]) chain[m] = () => chain;
  chain.limit = async () => [];
  return {
    db: { select: () => chain, query: { backupTargets: { findFirst: async () => undefined } } },
  };
});
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const POST = (await import("@/app/api/setup/backup/route")).POST as unknown as (r: NextRequest) => Promise<Response>;

const req = () =>
  new NextRequest("http://localhost/api/setup/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "s3", bucket: "b", region: "auto", accessKey: "a", secretKey: "s" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  ensureSystemBackup.mockResolvedValue(null);
});

describe("setup backup save", () => {
  it("ensures the Vardo database job after saving storage", async () => {
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(setSystemSetting).toHaveBeenCalled();
    expect(ensureSystemBackup).toHaveBeenCalledTimes(1);
  });

  it("still saves when job setup fails", async () => {
    ensureSystemBackup.mockRejectedValue(new Error("boom"));

    expect((await POST(req())).status).toBe(200);
  });
});
