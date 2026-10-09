import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn(async () => [{ address: "140.82.112.3" }]) }));
vi.mock("dns/promises", () => ({ lookup }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async () => null),
  getInstanceConfig: vi.fn(async () => ({ baseDomain: "" })),
}));

const { assertGitHostAllowed, GIT_NO_REDIRECT } = await import("@/lib/docker/git-host");

beforeEach(() => {
  delete process.env.VARDO_OUTBOUND_ALLOWLIST;
  lookup.mockResolvedValue([{ address: "140.82.112.3" }]);
});

describe("assertGitHostAllowed", () => {
  it("allows a public host", async () => {
    await expect(assertGitHostAllowed("https://github.com/acme/web.git")).resolves.toBeUndefined();
  });

  for (const url of [
    "https://127.0.0.1/acme/web.git",
    "https://localhost/acme/web.git",
    "https://169.254.169.254/acme/web.git",
    "https://192.168.1.10/acme/web.git",
    "https://[::1]/acme/web.git",
  ]) {
    it(`refuses ${url}`, async () => {
      lookup.mockResolvedValue([{ address: url.includes("localhost") ? "127.0.0.1" : "10.0.0.1" }]);
      await expect(assertGitHostAllowed(url)).rejects.toThrow(/Refusing/);
    });
  }

  it("refuses a name that resolves to a private address", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.19" }]);
    await expect(assertGitHostAllowed("https://gitea.lan/acme/web.git")).rejects.toThrow(/resolves to 10\.0\.0\.19/);
  });

  it("allows a private host named in VARDO_OUTBOUND_ALLOWLIST", async () => {
    process.env.VARDO_OUTBOUND_ALLOWLIST = "gitea.lan";
    lookup.mockResolvedValue([{ address: "10.0.0.19" }]);
    await expect(assertGitHostAllowed("https://gitea.lan/acme/web.git")).resolves.toBeUndefined();
  });
});

describe("GIT_NO_REDIRECT", () => {
  it("turns off HTTP redirects", () => {
    expect(GIT_NO_REDIRECT).toEqual(["-c", "http.followRedirects=false"]);
  });
});
