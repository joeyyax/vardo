// POST /api/v1/admin/maintenance/build-cache reclaims the daemon's cache through the Engine
// API, never a CLI prune, which would take stopped standby slots. BuildKit's cache goes through buildctl.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireAppAdmin, pruneBuildCache, getBuildCacheUsage, getBuildKitCacheUsage, pruneBuildKitCache, cp } = vi.hoisted(() => ({
  requireAppAdmin: vi.fn(),
  pruneBuildCache: vi.fn(),
  getBuildCacheUsage: vi.fn(),
  getBuildKitCacheUsage: vi.fn(),
  pruneBuildKitCache: vi.fn(),
  cp: { exec: vi.fn(), execFile: vi.fn(), spawn: vi.fn(), execSync: vi.fn(), spawnSync: vi.fn() },
}));

vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin }));
vi.mock("@/lib/docker/client", () => ({ pruneBuildCache, getBuildCacheUsage }));
vi.mock("@/lib/docker/buildkit", () => ({ getBuildKitCacheUsage, pruneBuildKitCache }));
vi.mock("child_process", () => ({ ...cp, default: cp }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const { POST, GET } = await import("@/app/api/v1/admin/maintenance/build-cache/route");

beforeEach(() => {
  vi.clearAllMocks();
  requireAppAdmin.mockResolvedValue({ user: { id: "u1" } });
  getBuildKitCacheUsage.mockResolvedValue(null);
  pruneBuildKitCache.mockResolvedValue(0);
});

describe("build-cache prune", () => {
  it("prunes all build cache through the Engine API and reports the space reclaimed", async () => {
    pruneBuildCache.mockResolvedValue({ spaceReclaimed: 4096 });
    const res = await (POST as () => Promise<Response>)();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reclaimed: 4096 });
    expect(pruneBuildCache).toHaveBeenCalledWith(undefined, { all: true });
  });

  it("adds BuildKit's cache to the size and the prune", async () => {
    getBuildCacheUsage.mockResolvedValue({ totalSize: 100, reclaimable: 40 });
    getBuildKitCacheUsage.mockResolvedValue({ totalSize: 5000, reclaimable: 3000 });
    expect(await (await (GET as () => Promise<Response>)()).json()).toEqual({ size: 5100, reclaimable: 3040 });

    pruneBuildCache.mockResolvedValue({ spaceReclaimed: 40 });
    pruneBuildKitCache.mockResolvedValue(3000);
    expect(await (await (POST as () => Promise<Response>)()).json()).toEqual({ ok: true, reclaimed: 3040 });
  });

  it("still prunes the daemon's cache when BuildKit's prune fails", async () => {
    pruneBuildCache.mockResolvedValue({ spaceReclaimed: 40 });
    pruneBuildKitCache.mockRejectedValue(new Error("exec"));
    expect(await (await (POST as () => Promise<Response>)()).json()).toEqual({ ok: true, reclaimed: 40 });
  });

  it("starts no child process", async () => {
    pruneBuildCache.mockResolvedValue({ spaceReclaimed: 0 });
    await (POST as () => Promise<Response>)();
    for (const fn of Object.values(cp)) expect(fn).not.toHaveBeenCalled();
  });

  it("prunes nothing for a non-admin", async () => {
    requireAppAdmin.mockRejectedValue(new Error("Forbidden"));
    const res = await (POST as () => Promise<Response>)();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(pruneBuildCache).not.toHaveBeenCalled();
  });

  it("reads usage as unknown, never zero, when the Engine fails", async () => {
    getBuildCacheUsage.mockRejectedValue(new Error("socket"));
    const res = await (GET as () => Promise<Response>)();
    expect(await res.json()).toEqual({ size: null, reclaimable: null });
  });
});
