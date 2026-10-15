import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { enabled, setEnabled } = vi.hoisted(() => ({ enabled: vi.fn(), setEnabled: vi.fn() }));

vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: vi.fn().mockResolvedValue({ user: { id: "admin-1" } }) }));
vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (handler: (...args: unknown[]) => unknown) => handler }));
vi.mock("@/lib/metrics/disk-setting", () => ({ getDiskMetricsEnabled: enabled, setDiskMetricsEnabled: setEnabled }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn(async () => true) }));

import { GET, POST } from "@/app/api/v1/admin/metrics/disk-metrics/route";

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/admin/metrics/disk-metrics", { method: "POST", body: JSON.stringify(body) });

describe("/api/v1/admin/metrics/disk-metrics", () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => vi.unstubAllEnvs());

  it("returns the setting and whether anything reads it", async () => {
    enabled.mockResolvedValue(true);
    expect(await (await GET(new NextRequest("http://localhost/x"))).json()).toEqual({ enabled: true, applies: true });
    vi.stubEnv("VARDO_COLLECTOR_IMAGE", "off");
    expect(await (await GET(new NextRequest("http://localhost/x"))).json()).toEqual({ enabled: true, applies: false });
  });

  it("saves it", async () => {
    const res = await POST(post({ enabled: true }), {});
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("rejects a non-boolean", async () => {
    expect((await POST(post({ enabled: "on" }), {})).status).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
  });
});
