import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkUpdateAlert } from "@/lib/system-alerts/monitor";
import { resetCommitUpdateCache } from "@/lib/version";
import { DEFAULT_POLICY, type UpdatePolicy } from "@/lib/self-update/policy";

const { emit, policy, selfDeploy } = vi.hoisted(() => ({
  emit: vi.fn(),
  policy: { current: null as UpdatePolicy | null },
  selfDeploy: { current: true },
}));

vi.mock("@/lib/config/health", () => ({ getSystemHealth: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit }));
vi.mock("@/lib/db", () => ({
  db: { query: { organizations: { findMany: vi.fn(async () => [{ id: "org1" }]) } } },
}));
vi.mock("@/lib/db/schema", () => ({ domainCertChecks: {}, systemSettings: {} }));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: vi.fn() }));
vi.mock("@/lib/system-alerts/cert-probe", () => ({ probeCertificate: vi.fn() }));
vi.mock("@/lib/system-alerts/state", () => ({
  shouldFire: vi.fn(() => true),
  markFired: vi.fn(),
  clearFired: vi.fn(),
  loadAlertState: vi.fn(),
}));
vi.mock("@/lib/self-update/store", () => ({ getUpdatePolicy: vi.fn(async () => policy.current) }));
vi.mock("@/lib/paths", async (orig) => ({
  ...(await orig<typeof import("@/lib/paths")>()),
  isSelfDeployLayout: () => selfDeploy.current,
}));

const LOCAL = "abc1234";
const REMOTE = "def5678901234567890123456789012345678901";
const fetchMock = vi.fn();

/** GitHub answers by path: the branch head, the latest release, a tag's commit and the compare. */
function github(routes: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = url.replace("https://api.github.com/repos/joeyyax/vardo", "");
    if (!(path in routes)) return new Response("not found", { status: 404 });
    const body = routes[path];
    return new Response(typeof body === "string" ? `${body}\n` : JSON.stringify(body), { status: 200 });
  });
}

describe("checkUpdateAlert", () => {
  beforeEach(() => {
    resetCommitUpdateCache();
    emit.mockReset();
    fetchMock.mockReset();
    policy.current = { ...DEFAULT_POLICY };
    selfDeploy.current = true;
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_GIT_SHA", LOCAL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stays quiet when the build matches main", async () => {
    github({ "/commits/main": `${LOCAL}${"0".repeat(33)}` });

    await checkUpdateAlert();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it("alerts with the commit count and Update now when main has moved past the build", async () => {
    github({ "/commits/main": REMOTE, [`/compare/${LOCAL}...${REMOTE}`]: { status: "ahead", ahead_by: 4 } });

    await checkUpdateAlert();

    expect(emit).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({
        type: "system.update-available",
        remoteHead: "def56789",
        localHead: LOCAL,
        channel: "main",
        commitsBehind: 4,
        selfDeploy: true,
      }),
    );
  });

  it("follows releases when the policy says so, and ignores a release behind the build", async () => {
    policy.current = { ...DEFAULT_POLICY, channel: "releases" };
    github({
      "/releases/latest": { tag_name: "v0.2.0", html_url: "https://github.com/joeyyax/vardo/releases/tag/v0.2.0" },
      "/commits/v0.2.0": REMOTE,
      [`/compare/${LOCAL}...${REMOTE}`]: { status: "behind", ahead_by: 0 },
    });

    await checkUpdateAlert();

    expect(emit).not.toHaveBeenCalled();
  });

  it("names the release tag when one is ahead", async () => {
    policy.current = { ...DEFAULT_POLICY, channel: "releases" };
    github({
      "/releases/latest": { tag_name: "v0.2.0" },
      "/commits/v0.2.0": REMOTE,
      [`/compare/${LOCAL}...${REMOTE}`]: { status: "ahead", ahead_by: 9 },
    });

    await checkUpdateAlert();

    expect(emit).toHaveBeenCalledWith("org1", expect.objectContaining({ channel: "releases", target: "v0.2.0" }));
  });

  it("sends nothing when updates are off or automatic", async () => {
    github({ "/commits/main": REMOTE, [`/compare/${LOCAL}...${REMOTE}`]: { status: "ahead", ahead_by: 1 } });
    for (const mode of ["off", "auto"] as const) {
      policy.current = { ...DEFAULT_POLICY, mode };
      await checkUpdateAlert();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("shows the host command on a legacy install", async () => {
    selfDeploy.current = false;
    github({ "/commits/main": REMOTE, [`/compare/${LOCAL}...${REMOTE}`]: { status: "ahead", ahead_by: 1 } });

    await checkUpdateAlert();

    expect(emit).toHaveBeenCalledWith("org1", expect.objectContaining({ selfDeploy: false }));
    expect(emit.mock.calls[0][1].message).toContain("Run vardo update");
  });

  it("caches the GitHub result between ticks", async () => {
    github({ "/commits/main": REMOTE, [`/compare/${LOCAL}...${REMOTE}`]: { status: "ahead", ahead_by: 1 } });

    await checkUpdateAlert();
    await checkUpdateAlert();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when GitHub is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(checkUpdateAlert()).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it("stays quiet when GitHub rate-limits", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 403 }));

    await checkUpdateAlert();

    expect(emit).not.toHaveBeenCalled();
  });

  it("skips the request when the build commit is unknown", async () => {
    vi.stubEnv("NEXT_PUBLIC_GIT_SHA", "");

    await checkUpdateAlert();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
