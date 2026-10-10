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

const { fetchRemoteDigest, fetchTags } = await import("@/lib/docker/image-updates/registry");
const { parseImageRef } = await import("@/lib/docker/image-updates/image-ref");

function challenge(realm: string) {
  return new Response(null, {
    status: 401,
    headers: { "www-authenticate": `Bearer realm="${realm}",service="reg"` },
  });
}

const ref = parseImageRef("reg.example.test/app:latest")!;
const REGISTRY = "https://reg.example.test/";

/** Registry responses in order; anything else is the token realm. */
function serve(registry: Response[], token: Response = Response.json({ token: "t" })) {
  safeFetch.mockImplementation(async (url: string) => (url.startsWith(REGISTRY) ? registry.shift() : token));
}

const realmCalls = () => safeFetch.mock.calls.filter(([url]) => !String(url).startsWith(REGISTRY));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VARDO_OUTBOUND_ALLOWLIST;
  lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
});

describe("registry requests", () => {
  it("go through the outbound guard with the operator's policy", async () => {
    serve([new Response(null, { headers: { "docker-content-digest": "sha256:a" } })]);
    expect(await fetchRemoteDigest(ref, "latest")).toBe("sha256:a");
    expect(safeFetch).toHaveBeenCalledWith(
      "https://reg.example.test/v2/app/manifests/latest",
      expect.objectContaining({ policy: expect.any(Object), method: "HEAD" }),
    );
  });

  it("follow tag pages through the guard too", async () => {
    safeFetch.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ tags: ["1"] }), { headers: { link: '<https://169.254.169.254/v2/x>; rel="next"' } }),
    );
    safeFetch.mockImplementationOnce(async () => {
      throw new Error("blocked");
    });
    await expect(fetchTags(ref)).rejects.toThrow("blocked");
    expect(safeFetch).toHaveBeenLastCalledWith("https://169.254.169.254/v2/x", expect.objectContaining({ policy: expect.any(Object) }));
  });
});

describe("registry token realm", () => {
  it("fetches a public https realm", async () => {
    serve([challenge("https://auth.example.test/token"), new Response(null, { headers: { "docker-content-digest": "sha256:a" } })]);
    expect(await fetchRemoteDigest(ref, "latest")).toBe("sha256:a");
    expect(realmCalls()).toHaveLength(1);
  });

  for (const realm of [
    "http://auth.example.test/token",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1:5000/token",
    "https://10.0.0.5/token",
  ]) {
    it(`refuses ${realm} without sending credentials`, async () => {
      serve([challenge(realm)]);
      await expect(fetchRemoteDigest(ref, "latest")).rejects.toThrow();
      expect(realmCalls()).toHaveLength(0);
    });
  }

  it("refuses a host that resolves to a private address", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.9" }]);
    serve([challenge("https://auth.example.test/token")]);
    await expect(fetchRemoteDigest(ref, "latest")).rejects.toThrow(/resolves to 10\.0\.0\.9/);
    expect(realmCalls()).toHaveLength(0);
  });

  it("allows a private realm the operator allowlisted", async () => {
    process.env.VARDO_OUTBOUND_ALLOWLIST = "auth.lan";
    lookup.mockResolvedValue([{ address: "10.0.0.9" }]);
    serve([challenge("https://auth.lan/token"), new Response(null, { headers: { "docker-content-digest": "sha256:b" } })]);
    expect(await fetchRemoteDigest(ref, "latest")).toBe("sha256:b");
  });
});
