// #876: the system backup default is instance-admin only.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { state, sw } = vi.hoisted(() => ({
  state: { admin: true },
  sw: {
    getSystemBackupsDefault: vi.fn(),
    setSystemBackupsDefault: vi.fn(),
    reconcileInBackground: vi.fn(),
  },
}));

vi.mock("@/lib/auth/admin", () => ({
  requireAppAdmin: async () => {
    if (!state.admin) throw new Error("Forbidden");
  },
}));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/backups/switch", () => sw);

const route = await import("@/app/api/v1/admin/backup-default/route");
const { GET } = route;
const PUT = route.PUT as unknown as (request: NextRequest) => Promise<Response>;

function put(body: unknown) {
  return new NextRequest("http://localhost/api/v1/admin/backup-default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.admin = true;
  sw.getSystemBackupsDefault.mockResolvedValue(true);
});

describe("admin backup default", () => {
  it("reads the default", async () => {
    const res = await GET();

    expect(await res.json()).toEqual({ enabled: true });
  });

  it("saves it and reconciles apps and orgs that inherit", async () => {
    const res = await PUT(put({ enabled: false }));

    expect(res.status).toBe(200);
    expect(sw.setSystemBackupsDefault).toHaveBeenCalledWith(false);
    expect(sw.reconcileInBackground).toHaveBeenCalledWith({ inheritOnly: true, orgInheritOnly: true, reenable: true });
  });

  it("rejects null, which has nothing to inherit", async () => {
    const res = await PUT(put({ enabled: null }));

    expect(res.status).toBe(400);
    expect(sw.setSystemBackupsDefault).not.toHaveBeenCalled();
  });

  it("refuses a non-admin", async () => {
    state.admin = false;

    const res = await PUT(put({ enabled: false }));

    expect(res.status).toBe(403);
    expect(sw.setSystemBackupsDefault).not.toHaveBeenCalled();
  });
});
