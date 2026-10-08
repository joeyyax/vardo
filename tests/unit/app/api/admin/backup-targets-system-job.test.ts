// #890: saving system backup storage creates Vardo's database job without a restart.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { ensureSystemBackup, insertedValues } = vi.hoisted(() => ({
  ensureSystemBackup: vi.fn(),
  insertedValues: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => {} }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/backups/switch", () => ({ reconcileInBackground: vi.fn() }));
vi.mock("@/lib/backups/auto-backup", () => ({ ensureSystemBackup }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/config/provider-restrictions", () => ({ isLocalBackupsAllowed: () => true }));
vi.mock("@/lib/backups/target-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/backups/target-config")>()),
  sealTargetConfig: (c: unknown) => c,
  presentTarget: (t: unknown) => t,
}));
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        insertedValues(v);
        return { returning: async () => [{ id: "t1", ...(v as object) }] };
      },
    }),
  },
}));

const POST = (await import("@/app/api/v1/admin/backup-targets/route")).POST as unknown as (
  r: NextRequest,
) => Promise<Response>;

function post() {
  return new NextRequest("http://localhost/api/v1/admin/backup-targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "qa-store",
      type: "s3",
      isDefault: true,
      config: { bucket: "b", region: "auto", accessKeyId: "a", secretAccessKey: "s" },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureSystemBackup.mockResolvedValue({ id: "job" });
});

describe("admin backup target create", () => {
  it("ensures the Vardo database job after saving the target", async () => {
    const res = await POST(post());

    expect(res.status).toBe(201);
    expect(ensureSystemBackup).toHaveBeenCalledTimes(1);
  });

  it("still saves the target when the job setup fails", async () => {
    ensureSystemBackup.mockRejectedValue(new Error("boom"));

    const res = await POST(post());

    expect(res.status).toBe(201);
  });
});
