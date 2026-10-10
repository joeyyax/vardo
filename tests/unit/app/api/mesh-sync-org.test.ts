// GET /api/v1/mesh/sync lists app names only for the org the calling peer is bound to.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { jsonRequest } from "@/tests/helpers/request";

const { requireMeshPeer, findMany } = vi.hoisted(() => ({ requireMeshPeer: vi.fn(), findMany: vi.fn() }));

vi.mock("@/lib/mesh/auth", async (original) => ({
  ...(await original<typeof import("@/lib/mesh/auth")>()),
  requireMeshPeer,
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/constants", () => ({ getInstanceId: vi.fn().mockResolvedValue("inst-1") }));
vi.mock("@/lib/db", () => ({ db: { query: { projects: { findMany } } } }));

const { GET } = await import("@/app/api/v1/mesh/sync/route");

const sync = (orgId: string) => GET(jsonRequest("GET", "/api/v1/mesh/sync", { query: { orgId } }));

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([{ id: "p1", name: "web", displayName: "Web", apps: [] }]);
});

describe("mesh sync", () => {
  it("lists the bound org's projects", async () => {
    requireMeshPeer.mockResolvedValue({ id: "peer-1", organizationId: "org-a" });
    const res = await sync("org-a");
    expect(res.status).toBe(200);
    expect((await res.json()).projects).toHaveLength(1);
  });

  it("refuses another org", async () => {
    requireMeshPeer.mockResolvedValue({ id: "peer-1", organizationId: "org-a" });
    expect((await sync("org-b")).status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("refuses a peer bound to no org", async () => {
    requireMeshPeer.mockResolvedValue({ id: "peer-1", organizationId: null });
    expect((await sync("org-a")).status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });
});
