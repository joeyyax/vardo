// POST /api/v1/admin/mesh/promote

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { buildBundle, meshFetch } = vi.hoisted(() => ({
  buildBundle: vi.fn(),
  meshFetch: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/mesh/transfers", () => ({ buildProjectBundle: buildBundle }));
vi.mock("@/lib/mesh/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mesh/client")>("@/lib/mesh/client");
  return { ...actual, meshJsonFetch: meshFetch };
});

import { POST } from "@/app/api/v1/admin/mesh/promote/route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/admin/mesh/promote", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    {} as never,
  );
}

// Matches the body built in components/mesh/project-instances.tsx.
const uiBody = {
  orgId: "org-1",
  projectId: "proj-1",
  targetPeerId: "peer-1",
  environment: "production",
  includeEnvVars: false,
};

describe("mesh promote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildBundle.mockResolvedValue({ project: { name: "p" } });
    meshFetch.mockResolvedValue({ ok: true });
  });

  it("accepts the body the UI sends", async () => {
    const res = await post(uiBody);
    expect(res.status).toBe(201);
    expect(buildBundle).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({ organizationId: "org-1" }),
    );
    expect(meshFetch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the project isn't in that org", async () => {
    buildBundle.mockRejectedValue(new Error("Project not found"));
    const res = await post({ ...uiBody, orgId: "org-2" });
    expect(res.status).not.toBe(201);
    expect(meshFetch).not.toHaveBeenCalled();
  });
});
