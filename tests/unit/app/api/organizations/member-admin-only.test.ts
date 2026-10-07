import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A member is refused each admin-only action at the route, through the real
// verifyOrgAccess and capability map.

const state = vi.hoisted(() => ({ role: "member", instanceAdmin: false }));

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
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => state.instanceAdmin }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: () => { throw new Error("db reached past the gate"); } }),
}));

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const params = { orgId: "org-1", appId: "app-1", backupId: "b-1", jobId: "j-1", targetId: "t-1", volumeName: "data", projectId: "p-1" };

// [label, route module, method]
const ADMIN_ONLY: [string, string, string][] = [
  ["restore a backup", "backups/history/[backupId]/restore", "POST"],
  ["download a backup", "backups/history/[backupId]/download", "GET"],
  ["create a backup target", "backups/targets", "POST"],
  ["edit a backup target", "backups/targets/[targetId]", "PATCH"],
  ["delete a backup target", "backups/targets/[targetId]", "DELETE"],
  ["see what deleting a backup target takes", "backups/targets/[targetId]", "GET"],
  ["create a backup job", "backups", "POST"],
  ["edit a backup job", "backups/jobs/[jobId]", "PATCH"],
  ["delete a backup job", "backups/jobs/[jobId]", "DELETE"],
  ["sync files into a volume", "apps/[appId]/volumes/[volumeName]/sync", "POST"],
  ["delete a project", "projects/[projectId]", "DELETE"],
];

const modules: Record<string, () => Promise<Record<string, unknown>>> = {
  "backups/history/[backupId]/restore": () => import("@/app/api/v1/organizations/[orgId]/backups/history/[backupId]/restore/route"),
  "backups/history/[backupId]/download": () => import("@/app/api/v1/organizations/[orgId]/backups/history/[backupId]/download/route"),
  "apps/[appId]/volumes/[volumeName]/sync": () => import("@/app/api/v1/organizations/[orgId]/apps/[appId]/volumes/[volumeName]/sync/route"),
  "projects/[projectId]": () => import("@/app/api/v1/organizations/[orgId]/projects/[projectId]/route"),
  "backups": () => import("@/app/api/v1/organizations/[orgId]/backups/route"),
  "backups/jobs/[jobId]": () => import("@/app/api/v1/organizations/[orgId]/backups/jobs/[jobId]/route"),
  "backups/targets": () => import("@/app/api/v1/organizations/[orgId]/backups/targets/route"),
  "backups/targets/[targetId]": () => import("@/app/api/v1/organizations/[orgId]/backups/targets/[targetId]/route"),
};

beforeEach(() => {
  state.role = "member";
  state.instanceAdmin = false;
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

describe("an instance admin who is a member", () => {
  const backupActions = ADMIN_ONLY.filter(([, route]) => route.startsWith("backups"));

  it.each(backupActions)("may %s", async (_label, route, method) => {
    state.instanceAdmin = true;
    const handler = (await modules[route]())[method] as Handler;
    const req = new NextRequest(`http://localhost/api/v1/organizations/org-1/${route}`, {
      method,
      body: method === "GET" ? undefined : "{}",
    });

    const res = await handler(req, { params: Promise.resolve(params) });
    expect(res.status).not.toBe(403);
  });

  it("still may not delete a project", async () => {
    state.instanceAdmin = true;
    const handler = (await modules["projects/[projectId]"]()).DELETE as Handler;
    const req = new NextRequest("http://localhost/api/v1/organizations/org-1/projects/p-1", { method: "DELETE" });

    const res = await handler(req, { params: Promise.resolve(params) });
    expect(res.status).toBe(403);
  });
});
