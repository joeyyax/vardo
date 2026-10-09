// /api/v1/admin/resources: admin-only reads and writes of per-app sizing defaults.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { requireAppAdmin, state } = vi.hoisted(() => ({
  requireAppAdmin: vi.fn(),
  state: { saved: {} as Record<string, number>, host: { cpus: 8, memoryBytes: 32 * 1024 ** 3 } as { cpus: number; memoryBytes: number } | null },
}));

vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/resources/host", async () => {
  const { describeDefaults } = await import("@/lib/resources/defaults");
  return {
    detectHost: async () => state.host,
    hostCpuCount: (h: { cpus: number } | null) => h?.cpus ?? 4,
    loadResourceSettings: async () => ({ ...state.saved }),
    saveResourceSettings: vi.fn(async (v: Record<string, number>) => {
      state.saved = { ...v };
    }),
    currentDefaults: async () => ({ host: state.host, defaults: describeDefaults(state.host, 4, process.env, undefined, state.saved) }),
  };
});

const { GET, PUT } = await import("@/app/api/v1/admin/resources/route");
const host = await import("@/lib/resources/host");

type Row = { key: string; value: number | null; source: string };

function put(body: unknown) {
  const req = new NextRequest("http://localhost/api/v1/admin/resources", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (PUT as (r: NextRequest) => Promise<Response>)(req);
}

const row = async (res: Response, key: string) => ((await res.json()).defaults as Row[]).find((r) => r.key === key);

beforeEach(() => {
  vi.clearAllMocks();
  requireAppAdmin.mockResolvedValue({ user: { id: "u1" } });
  state.saved = {};
  state.host = { cpus: 8, memoryBytes: 32 * 1024 ** 3 };
});
afterEach(() => vi.unstubAllEnvs());

describe("auth", () => {
  it("answers 401 without a session", async () => {
    requireAppAdmin.mockRejectedValue(new Error("Unauthorized"));
    expect((await (GET as () => Promise<Response>)()).status).toBe(401);
    expect((await put({ values: { deployConcurrency: 3 } })).status).toBe(401);
    expect(host.saveResourceSettings).not.toHaveBeenCalled();
  });

  it("answers 403 for a non-admin and saves nothing", async () => {
    requireAppAdmin.mockRejectedValue(new Error("Forbidden"));
    expect((await (GET as () => Promise<Response>)()).status).toBe(403);
    expect((await put({ values: { deployConcurrency: 3 } })).status).toBe(403);
    expect(host.saveResourceSettings).not.toHaveBeenCalled();
  });
});

describe("PUT", () => {
  it("saves a value and reports it as admin-set", async () => {
    const res = await put({ values: { memoryStandard: 3072 } });
    expect(res.status).toBe(200);
    expect(state.saved).toEqual({ memoryStandard: 3072 });
    expect(await row(res, "memoryStandard")).toMatchObject({ value: 3072, source: "admin" });
  });

  it("resets a value with null", async () => {
    state.saved = { memoryStandard: 3072, deployConcurrency: 3 };
    const res = await put({ values: { memoryStandard: null } });
    expect(res.status).toBe(200);
    expect(state.saved).toEqual({ deployConcurrency: 3 });
    expect(await row(res, "memoryStandard")).toMatchObject({ source: "detected" });
  });

  it.each([
    [{ memoryStandard: 100 }, /128/],
    [{ cpusStandard: 0.1 }, /0.25/],
    [{ cpusDisposable: 9 }, /host's 8/],
    [{ deployConcurrency: 33 }, /1 to 32/],
    [{ deployConcurrency: 0 }, /1 to 32/],
  ])("refuses %o", async (values, message) => {
    const res = await put({ values });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(host.saveResourceSettings).not.toHaveBeenCalled();
  });

  it("refuses keys an admin can't set", async () => {
    expect((await put({ values: { cpusCritical: 2 } })).status).toBe(400);
    expect((await put({ values: { redisMem: 1024 } })).status).toBe(400);
    expect(host.saveResourceSettings).not.toHaveBeenCalled();
  });

  it("refuses a value the env would override", async () => {
    vi.stubEnv("VARDO_MAX_DEPLOY_CONCURRENCY", "3");
    const res = await put({ values: { deployConcurrency: 5 } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/VARDO_MAX_DEPLOY_CONCURRENCY/);
    expect(host.saveResourceSettings).not.toHaveBeenCalled();
  });

  it("still clears a stale value under an env lock", async () => {
    vi.stubEnv("VARDO_MAX_DEPLOY_CONCURRENCY", "3");
    state.saved = { deployConcurrency: 5 };
    expect((await put({ values: { deployConcurrency: null } })).status).toBe(200);
    expect(state.saved).toEqual({});
  });
});
