import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkUpdateAlert } from "@/lib/system-alerts/monitor";
import { resetCommitUpdateCache } from "@/lib/version";

const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));

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

const LOCAL = "abc1234";
const fetchMock = vi.fn();

function remoteHead(sha: string) {
  fetchMock.mockResolvedValue(new Response(`${sha}\n`, { status: 200 }));
}

describe("checkUpdateAlert", () => {
  beforeEach(() => {
    resetCommitUpdateCache();
    emit.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_GIT_SHA", LOCAL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stays quiet when the build matches main", async () => {
    remoteHead(`${LOCAL}0000000000000000000000000000000000`.slice(0, 40));

    await checkUpdateAlert();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/joeyyax/vardo/commits/main",
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("alerts when main has moved past the build", async () => {
    remoteHead("def5678901234567890123456789012345678901");

    await checkUpdateAlert();

    expect(emit).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({
        type: "system.update-available",
        remoteHead: "def56789",
        localHead: LOCAL,
      }),
    );
  });

  it("caches the GitHub result between ticks", async () => {
    remoteHead("def5678901234567890123456789012345678901");

    await checkUpdateAlert();
    await checkUpdateAlert();

    expect(fetchMock).toHaveBeenCalledOnce();
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
