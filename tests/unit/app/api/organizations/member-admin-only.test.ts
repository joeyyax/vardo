import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A member is refused each admin-only action at the route, through the real
// verifyOrgAccess and capability map.

const state = vi.hoisted(() => ({ role: "member" }));

vi.mock("@/lib/auth/session", () => ({
  requireOrg: async () => ({
    organization: { id: "org-1" },
    membership: { id: "m1", role: state.role },
    session: { user: { id: "u1" } },
  }),
}));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: () => { throw new Error("db reached past the gate"); } }),
}));

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const params = { orgId: "org-1", appId: "app-1", backupId: "b-1", jobId: "j-1", targetId: "t-1", volumeName: "data" };

// [label, route module, method]
const ADMIN_ONLY: [string, string, string][] = [
  ["restore a backup", "backups/history/[backupId]/restore", "POST"],
  ["download a backup", "backups/history/[backupId]/download", "GET"],
];

const modules: Record<string, () => Promise<Record<string, unknown>>> = {
  "backups/history/[backupId]/restore": () => import("@/app/api/v1/organizations/[orgId]/backups/history/[backupId]/restore/route"),
  "backups/history/[backupId]/download": () => import("@/app/api/v1/organizations/[orgId]/backups/history/[backupId]/download/route"),
};

beforeEach(() => {
  state.role = "member";
});

describe("admin-only actions", () => {
  it.each(ADMIN_ONLY)("refuses a member who tries to %s", async (_label, route, method) => {
    const mod = await modules[route]();
    const handler = mod[method] as Handler;
    const req = new NextRequest(`http://localhost/api/v1/organizations/org-1/${route}`, {
      method,
      body: method === "GET" ? undefined : "{}",
    });

    const res = await handler(req, { params: Promise.resolve(params) });
    expect(res.status).toBe(403);
  });
});
