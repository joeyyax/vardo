// An instance admin allows a host path for bind mounts; denied paths never.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { jsonRequest } from "@/tests/helpers/request";

const { allowBindPathMock } = vi.hoisted(() => ({ allowBindPathMock: vi.fn() }));

vi.mock("@/lib/auth/admin", async () => (await import("@/tests/helpers/mocks")).adminModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/docker/bind-roots", async (original) => ({
  ...(await original<typeof import("@/lib/docker/bind-roots")>()),
  allowBindPath: allowBindPathMock,
  getAllowedBindPaths: vi.fn().mockResolvedValue([]),
}));

const { requireAppAdmin } = await import("@/lib/auth/admin");
const { POST } = await import("@/app/api/v1/admin/bind-mounts/route");

const post = (path: unknown) => POST(jsonRequest("POST", "/api/v1/admin/bind-mounts", { body: { path } }));

beforeEach(() => {
  vi.clearAllMocks();
  allowBindPathMock.mockImplementation(async (p: string) => [p]);
});

describe("POST /api/v1/admin/bind-mounts", () => {
  it("adds a normalized path to the instance list", async () => {
    const res = await post("/home/media/");
    expect(res.status).toBe(200);
    expect(allowBindPathMock).toHaveBeenCalledWith("/home/media");
  });

  it.each(["/", "relative/path", "/etc/ssl", "/proc"])("refuses %s", async (path) => {
    const res = await post(path);
    expect(res.status).toBe(400);
    expect(allowBindPathMock).not.toHaveBeenCalled();
  });

  it("refuses anyone but an instance admin", async () => {
    const { AdminAuthError } = await import("@/lib/auth/admin-error");
    vi.mocked(requireAppAdmin).mockRejectedValueOnce(new AdminAuthError(403));
    const res = await post("/home/media");
    expect(res.status).toBe(403);
    expect(allowBindPathMock).not.toHaveBeenCalled();
  });
});
