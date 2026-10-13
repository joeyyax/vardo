import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getChannelUpdate, resetCommitUpdateCache } from "@/lib/version";
import { getGitHubCheckError, githubGet } from "@/lib/github-api";

const install = vi.hoisted(() => ({ row: null as { installationId: number } | null, token: vi.fn(async () => "ghs_installation") }));

vi.mock("@/lib/db", () => ({ db: { query: { githubAppInstallations: { findFirst: vi.fn(async () => install.row) } } } }));
vi.mock("@/lib/db/schema", () => ({ githubAppInstallations: { createdAt: "created_at" } }));
vi.mock("@/lib/git-integration/app", () => ({ getInstallationToken: install.token }));

const LOCAL = "abc1234";
const REMOTE = "def5678901234567890123456789012345678901";
const fetchMock = vi.fn();

function headersOf(call: number): Record<string, string> {
  return fetchMock.mock.calls[call][1].headers;
}

const limited = (reset: number) =>
  new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
  });

describe("GitHub update checks", () => {
  beforeEach(() => {
    resetCommitUpdateCache();
    fetchMock.mockReset();
    install.row = null;
    install.token.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_GIT_SHA", LOCAL);
    vi.stubEnv("VARDO_GITHUB_TOKEN", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("surfaces a rate limit with its reset time and claims no update", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    fetchMock.mockResolvedValue(limited(reset));

    expect(await getChannelUpdate("main")).toBeNull();

    expect(getGitHubCheckError()).toMatchObject({ rateLimited: true, status: 403, resetsAt: new Date(reset * 1000).toISOString() });
  });

  it("stops calling GitHub until the limit resets", async () => {
    fetchMock.mockResolvedValue(limited(Math.floor(Date.now() / 1000) + 1800));

    await getChannelUpdate("main");
    await getChannelUpdate("main", { fresh: true });
    await getChannelUpdate("releases", { fresh: true });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("checks again after the reset and clears the error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockResolvedValueOnce(limited(Math.floor(Date.now() / 1000) + 600));
    await getChannelUpdate("main");

    vi.advanceTimersByTime(601_000);
    fetchMock.mockImplementation(async (url: string) =>
      new Response(url.endsWith("/commits/main") ? REMOTE : JSON.stringify({ status: "ahead", ahead_by: 2 }), { status: 200 }),
    );
    const update = await getChannelUpdate("main", { fresh: true });

    expect(update?.hasUpdate).toBe(true);
    expect(getGitHubCheckError()).toBeNull();
  });

  it("reports a network failure as a failed check", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.github.com"));

    expect(await getChannelUpdate("main")).toBeNull();

    expect(getGitHubCheckError()).toMatchObject({ rateLimited: false, status: null });
  });

  it("reuses the cached target on a 304", async () => {
    fetchMock.mockResolvedValueOnce(new Response(LOCAL + "0".repeat(33), { status: 200, headers: { etag: '"v1"' } }));
    const first = await getChannelUpdate("main");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const second = await getChannelUpdate("main", { fresh: true });

    expect(headersOf(1)["If-None-Match"]).toBe('"v1"');
    expect(second).toEqual(first);
    expect(second?.hasUpdate).toBe(false);
    expect(getGitHubCheckError()).toBeNull();
  });

  it("sends the env token", async () => {
    vi.stubEnv("VARDO_GITHUB_TOKEN", "ghp_env");
    fetchMock.mockResolvedValue(new Response(LOCAL + "0".repeat(33), { status: 200 }));

    await getChannelUpdate("main");

    expect(headersOf(0).Authorization).toBe("Bearer ghp_env");
  });

  it("falls back to a GitHub App installation token", async () => {
    install.row = { installationId: 42 };
    fetchMock.mockResolvedValue(new Response(LOCAL + "0".repeat(33), { status: 200 }));

    await getChannelUpdate("main");

    expect(install.token).toHaveBeenCalledWith(42);
    expect(headersOf(0).Authorization).toBe("Bearer ghs_installation");
  });

  it("goes unauthenticated when no credential exists", async () => {
    fetchMock.mockResolvedValue(new Response(LOCAL + "0".repeat(33), { status: 200 }));

    await getChannelUpdate("main");

    expect(headersOf(0).Authorization).toBeUndefined();
  });

  it("retries without a credential GitHub rejects", async () => {
    vi.stubEnv("VARDO_GITHUB_TOKEN", "ghp_revoked");
    fetchMock.mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));
    fetchMock.mockResolvedValueOnce(new Response(LOCAL + "0".repeat(33), { status: 200 }));

    const update = await getChannelUpdate("main");

    expect(update?.hasUpdate).toBe(false);
    expect(headersOf(1).Authorization).toBeUndefined();
  });

  it("returns a 404 as a result, not a failed check", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

    const res = await githubGet("joeyyax/vardo", "/compare/a...b", "application/vnd.github+json");

    expect(res.ok).toBe(false);
    expect(getGitHubCheckError()).toBeNull();
  });
});
