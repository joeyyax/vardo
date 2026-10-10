import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const { verifyOrgAccess } = vi.hoisted(() => ({ verifyOrgAccess: vi.fn() }));
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));

const { POST } = (await import("@/app/api/v1/organizations/[orgId]/compose/analyze/route")) as unknown as {
  POST: (req: NextRequest, ctx: { params: Promise<{ orgId: string }> }) => Promise<Response>;
};

const call = () =>
  POST(
    new NextRequest("http://localhost/api/v1/organizations/org-b/compose/analyze", {
      method: "POST",
      body: JSON.stringify({ composeContent: "services:\n  web:\n    image: nginx\n" }),
    }),
    { params: Promise.resolve({ orgId: "org-b" }) },
  );

describe("POST compose/analyze", () => {
  it("refuses a caller outside the org", async () => {
    verifyOrgAccess.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
  });

  it("analyzes for a member", async () => {
    verifyOrgAccess.mockResolvedValue({ organization: { id: "org-b" } });
    expect((await call()).status).toBe(200);
  });
});
