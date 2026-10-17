import { describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/security/pinned-fetch", () => ({ pinnedFetch: fetchMock }));
vi.mock("@/lib/uptime/dns-cache", () => ({ uptimeLookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

const { checkDeps } = await import("@/lib/uptime/outbound");
const { runHttpCheck } = await import("@/lib/uptime/core");

describe("a check through Vardo's outbound fetch", () => {
  it("follows a basePath redirect from /healthz to /docs/healthz", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/docs/healthz" } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const { fetch } = await checkDeps("strict");
    const res = await runHttpCheck(
      { type: "http", url: "https://docs.example.com/healthz", expectedStatus: { min: 200, max: 299 }, timeoutMs: 1000 },
      { monitorId: "m", vantageId: "local", path: "local", fetch },
    );
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://docs.example.com/docs/healthz");
  });
});
