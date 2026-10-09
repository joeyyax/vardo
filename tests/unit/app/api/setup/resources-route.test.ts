// GET /api/setup/resources: the host's size and picked defaults for the setup summary.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { state, requireAdminAuth } = vi.hoisted(() => ({
  state: { needsSetup: true, host: null as { cpus: number; memoryBytes: number } | null },
  requireAdminAuth: vi.fn(),
}));

vi.mock("@/lib/setup", () => ({ needsSetup: async () => state.needsSetup }));
vi.mock("@/lib/auth/admin", () => ({ requireAdminAuth }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/resources/host", () => ({
  detectHost: async () => state.host,
  hostCpuCount: (h: { cpus: number } | null) => h?.cpus ?? 4,
  loadResourceSettings: async () => ({}),
}));

const { GET } = await import("@/app/api/setup/resources/route");
const get = () => (GET as (r: NextRequest) => Promise<Response>)(new NextRequest("http://localhost/api/setup/resources"));

beforeEach(() => {
  state.needsSetup = true;
  state.host = null;
  requireAdminAuth.mockReset();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SETUP_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/setup/resources", () => {
  it("shows the host's size class and the defaults it picked", async () => {
    state.host = { cpus: 8, memoryBytes: 32 * 1024 ** 3 };
    const body = await (await get()).json();
    expect(body.host).toMatchObject({ cpus: 8, sizeClass: "large" });
    const by = Object.fromEntries(body.defaults.map((d: { key: string; value: number }) => [d.key, d.value]));
    expect(by).toEqual({
      memoryCritical: 4096,
      memoryStandard: 2048,
      memoryDisposable: 1024,
      cpusStandard: 7,
      cpusDisposable: 4,
      deployConcurrency: 4,
    });
  });

  it("shows the fallbacks when detection fails", async () => {
    const body = await (await get()).json();
    expect(body.host).toBeNull();
    expect(body.defaults.every((d: { source: string }) => d.source === "fallback")).toBe(true);
    expect(body.defaults.find((d: { key: string }) => d.key === "memoryStandard").value).toBe(1024);
  });

  it("needs no session during setup", async () => {
    expect((await get()).status).toBe(200);
    expect(requireAdminAuth).not.toHaveBeenCalled();
  });

  it("needs an admin once setup is done", async () => {
    state.needsSetup = false;
    requireAdminAuth.mockRejectedValue(new Error("Unauthorized"));
    expect((await get()).status).toBe(401);
  });
});
