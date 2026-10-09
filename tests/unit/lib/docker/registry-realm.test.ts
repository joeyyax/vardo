import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch, lookup } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  lookup: vi.fn(async () => [{ address: "93.184.216.34" }]),
}));

vi.mock("dns/promises", () => ({ lookup }));
vi.mock("@/lib/security/safe-fetch", () => ({ safeFetch }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async (key: string) =>
    key === "registry_credentials" ? JSON.stringify({ "reg.example.test": { username: "u", password: "p" } }) : null,
  ),
}));

const { fetchRemoteDigest } = await import("@/lib/docker/image-updates/registry");
const { parseImageRef } = await import("@/lib/docker/image-updates/image-ref");

function challenge(realm: string) {
  return new Response(null, {
    status: 401,
    headers: { "www-authenticate": `Bearer realm="${realm}",service="reg"` },
  });
}

const ref = parseImageRef("reg.example.test/app:latest")!;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VARDO_OUTBOUND_ALLOWLIST;
  lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
});

describe("registry token realm", () => {
  it("fetches a public https realm", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(challenge("https://auth.example.test/token"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { headers: { "docker-content-digest": "sha256:a" } }));
    safeFetch.mockResolvedValueOnce(Response.json({ token: "t" }));

    expect(await fetchRemoteDigest(ref, "latest")).toBe("sha256:a");
    expect(safeFetch).toHaveBeenCalledOnce();
  });

  for (const realm of [
    "http://auth.example.test/token",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1:5000/token",
    "https://10.0.0.5/token",
  ]) {
    it(`refuses ${realm} without sending credentials`, async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(challenge(realm));
      await expect(fetchRemoteDigest(ref, "latest")).rejects.toThrow();
      expect(safeFetch).not.toHaveBeenCalled();
    });
  }

  it("refuses a host that resolves to a private address", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.9" }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(challenge("https://auth.example.test/token"));
    await expect(fetchRemoteDigest(ref, "latest")).rejects.toThrow(/resolves to 10\.0\.0\.9/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("allows a private realm the operator allowlisted", async () => {
    process.env.VARDO_OUTBOUND_ALLOWLIST = "auth.lan";
    lookup.mockResolvedValue([{ address: "10.0.0.9" }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(challenge("https://auth.lan/token"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { headers: { "docker-content-digest": "sha256:b" } }));
    safeFetch.mockResolvedValueOnce(Response.json({ token: "t" }));
    expect(await fetchRemoteDigest(ref, "latest")).toBe("sha256:b");
  });
});
