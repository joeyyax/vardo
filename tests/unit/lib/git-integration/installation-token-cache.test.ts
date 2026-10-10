import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@/lib/system-settings", () => ({ getGitHubAppConfig: async () => ({ appId: "1", privateKey: "k" }) }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = { apps: { createInstallationAccessToken: create } };
  },
}));

const { getInstallationToken } = await import("@/lib/git-integration/app");

describe("getInstallationToken", () => {
  afterEach(() => vi.useRealTimers());

  it("reuses a token until five minutes before it expires", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00Z"), toFake: ["Date"] });
    create.mockResolvedValueOnce({ data: { token: "a", expires_at: "2026-01-01T01:00:00Z" } });
    create.mockResolvedValueOnce({ data: { token: "b", expires_at: "2026-01-01T02:00:00Z" } });

    expect(await getInstallationToken(7)).toBe("a");
    vi.setSystemTime(Date.parse("2026-01-01T00:54:00Z"));
    expect(await getInstallationToken(7)).toBe("a");
    vi.setSystemTime(Date.parse("2026-01-01T00:56:00Z"));
    expect(await getInstallationToken(7)).toBe("b");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("keeps installations apart", async () => {
    create.mockResolvedValueOnce({ data: { token: "x", expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    expect(await getInstallationToken(8)).toBe("x");
  });
});
