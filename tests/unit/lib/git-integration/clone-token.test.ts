import { describe, it, expect, vi } from "vitest";
import { resolveCloneToken, parseGithubRepo } from "@/lib/git-integration/clone-auth";

const mine = { installationId: 1, accountLogin: "joeyyax" };
const grady = { installationId: 2, accountLogin: "ClientCo" };
const url = "https://github.com/ClientCo/Acme Nonprofit.git";

function deps(over: Partial<Parameters<typeof resolveCloneToken>[2]> = {}) {
  return {
    getToken: vi.fn(async (id: number) => `token-${id}`),
    getRepoInstallationId: vi.fn(async () => null as number | null),
    ...over,
  };
}

describe("parseGithubRepo", () => {
  it("reads owner and repo", () => {
    expect(parseGithubRepo(url)).toEqual({ owner: "ClientCo", repo: "Acme Nonprofit" });
    expect(parseGithubRepo("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("resolveCloneToken", () => {
  it("uses the installation GitHub reports for the repo, not the first one", async () => {
    const d = deps({ getRepoInstallationId: vi.fn(async () => 2) });
    expect(await resolveCloneToken(url, [mine, grady], d)).toBe("token-2");
    expect(d.getToken).toHaveBeenCalledTimes(1);
  });

  it("matches the owner's account when the lookup finds nothing", async () => {
    const d = deps();
    expect(await resolveCloneToken(url, [mine, grady], d)).toBe("token-2");
  });

  it("matches the owner case-insensitively when the lookup throws", async () => {
    const d = deps({ getRepoInstallationId: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await resolveCloneToken(url.replace("ClientCo", "ClientCo"), [mine, grady], d)).toBe("token-2");
  });

  it("falls back to each installation in turn", async () => {
    const d = deps({ getToken: vi.fn(async (id: number) => { if (id === 1) throw new Error("revoked"); return `token-${id}`; }) });
    expect(await resolveCloneToken("https://github.com/someone/else", [mine, grady], d)).toBe("token-2");
  });

  it("returns null when no installation yields a token", async () => {
    const d = deps({ getToken: vi.fn(async () => { throw new Error("nope"); }) });
    expect(await resolveCloneToken(url, [mine, grady], d)).toBeNull();
    expect(await resolveCloneToken(url, [], deps())).toBeNull();
  });
});
