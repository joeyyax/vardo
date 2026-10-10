// The poller deploys a new head once, skips everything else and backs off a failing git host.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PollDeps } from "@/lib/git-integration/poll-scheduler";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: vi.fn(), setSystemSetting: vi.fn() }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ deployInFlight: vi.fn(), requestDeploy: vi.fn() }));
vi.mock("@/lib/git-integration/remote-head", () => ({ lsRemoteHead: vi.fn() }));

const { decidePoll, hostCooldown, getPollIntervalMinutes } = await import("@/lib/git-integration/poll");
const { pollApp } = await import("@/lib/git-integration/poll-scheduler");
const { getSystemSettingRaw } = await import("@/lib/system-settings");

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

const base = {
  parked: false,
  status: "active",
  inFlight: false as const,
  remoteSha: NEW,
  lastDeployedSha: OLD,
  polledSha: OLD,
  shaHasDeployment: false,
};

describe("decidePoll", () => {
  it("deploys a new head", () => {
    expect(decidePoll(base)).toEqual({ action: "deploy" });
  });

  it.each([
    ["the deployed head", { remoteSha: OLD }, "up to date"],
    ["a deploy in flight", { inFlight: true as const }, "deploy in flight"],
    ["an unknown in-flight state", { inFlight: "unknown" as const }, "deploy in flight"],
    ["a parked app", { parked: true }, "parked"],
    ["a stopped app", { status: "stopped" }, "stopped"],
    ["a head that already failed", { polledSha: NEW }, "already handled"],
    ["a head a webhook already deployed or queued", { shaHasDeployment: true }, "already deployed or attempted"],
  ])("skips %s", (_label, change, reason) => {
    expect(decidePoll({ ...base, ...change })).toEqual({ action: "skip", reason });
  });

  it("records a baseline instead of deploying an app it has never seen deploy", () => {
    expect(decidePoll({ ...base, lastDeployedSha: null, polledSha: null })).toEqual({ action: "baseline" });
  });

  it("deploys a move past the baseline", () => {
    expect(decidePoll({ ...base, lastDeployedSha: null, polledSha: OLD })).toEqual({ action: "deploy" });
  });
});

describe("hostCooldown", () => {
  it("doubles from the interval up to the cap, and clears on success", async () => {
    const b = hostCooldown(undefined, 30 * 60_000, () => 1);
    const now = 1_000_000;
    expect(await b.fail("git.example.com", { baseMs: 5 * 60_000, now })).toBe(5 * 60_000);
    expect(await b.fail("git.example.com", { baseMs: 5 * 60_000, now })).toBe(10 * 60_000);
    expect(await b.fail("git.example.com", { baseMs: 5 * 60_000, now })).toBe(20 * 60_000);
    expect(await b.fail("git.example.com", { baseMs: 5 * 60_000, now })).toBe(30 * 60_000);
    expect(await b.blocked("git.example.com", now + 29 * 60_000)).toBe(true);
    expect(await b.blocked("other.example.com", now)).toBe(false);
    await b.succeed("git.example.com");
    expect(await b.blocked("git.example.com", now)).toBe(false);
  });

  it("never waits less than the interval, however the jitter lands", async () => {
    const b = hostCooldown(undefined, 30 * 60_000, () => 0);
    await b.fail("git.example.com", { baseMs: 5 * 60_000 });
    expect(await b.fail("git.example.com", { baseMs: 5 * 60_000 })).toBe(5 * 60_000);
  });
});

describe("pollApp", () => {
  const app = {
    id: "app-1",
    name: "site",
    organizationId: "org-a",
    gitUrl: "https://github.com/acme/site.git",
    gitBranch: "main",
    gitCredentials: null,
    gitKeyId: null,
    parked: false,
    status: "active",
    gitPolledSha: OLD,
  };

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      lsRemoteHead: vi.fn().mockResolvedValue(NEW),
      deployInFlight: vi.fn().mockResolvedValue(false),
      deployHistory: vi.fn().mockResolvedValue({ lastDeployedSha: OLD, shaHasDeployment: false, queuedOrRunning: false }),
      recordPoll: vi.fn().mockResolvedValue(undefined),
      requestDeploy: vi.fn().mockResolvedValue({ deploymentId: "d", success: true }),
      backoff: hostCooldown(undefined, undefined, () => 0),
      ...overrides,
    } as unknown as PollDeps;
  }

  it("deploys a new head with the poll trigger and remembers it", async () => {
    const d = deps();
    expect(await pollApp(app, 300_000, d)).toEqual({ action: "deploy" });
    expect(d.requestDeploy).toHaveBeenCalledWith({ appId: "app-1", organizationId: "org-a", trigger: "poll" });
    expect(d.recordPoll).toHaveBeenCalledWith("app-1", { sha: NEW, error: null });
  });

  it("treats a queued deployment row as in flight", async () => {
    const d = deps({
      deployHistory: vi.fn().mockResolvedValue({ lastDeployedSha: OLD, shaHasDeployment: false, queuedOrRunning: true }),
    });
    expect(await pollApp(app, 300_000, d)).toEqual({ action: "skip", reason: "deploy in flight" });
    expect(d.requestDeploy).not.toHaveBeenCalled();
  });

  it("doesn't retry a head that already failed", async () => {
    const d = deps();
    expect(await pollApp({ ...app, gitPolledSha: NEW }, 300_000, d)).toEqual({ action: "skip", reason: "already handled" });
    expect(d.requestDeploy).not.toHaveBeenCalled();
  });

  it("backs off a host that errors and skips its apps until the backoff ends", async () => {
    const d = deps({ lsRemoteHead: vi.fn().mockRejectedValue(new Error("HTTP 503")) });
    expect(await pollApp(app, 300_000, d)).toEqual({ action: "error", reason: "HTTP 503" });
    expect(d.recordPoll).toHaveBeenCalledWith("app-1", { error: "HTTP 503" });

    const next = await pollApp({ ...app, id: "app-2" }, 300_000, d);
    expect(next).toEqual({ action: "skip", reason: "backing off github.com" });
    expect(d.lsRemoteHead).toHaveBeenCalledTimes(1);
    expect(d.requestDeploy).not.toHaveBeenCalled();
  });
});

describe("getPollIntervalMinutes", () => {
  beforeEach(() => vi.mocked(getSystemSettingRaw).mockReset());

  it("defaults to five minutes", async () => {
    vi.mocked(getSystemSettingRaw).mockResolvedValue(null);
    expect(await getPollIntervalMinutes()).toBe(5);
  });

  it("reads zero as off", async () => {
    vi.mocked(getSystemSettingRaw).mockResolvedValue("0");
    expect(await getPollIntervalMinutes()).toBe(0);
  });

  it("ignores garbage", async () => {
    vi.mocked(getSystemSettingRaw).mockResolvedValue("soon");
    expect(await getPollIntervalMinutes()).toBe(5);
  });
});
