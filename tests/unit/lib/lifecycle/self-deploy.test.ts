import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  isConsoleHandover,
  isOtherConsole,
  parseUpdateMarker,
  ranSelfDeploy,
  stoppingForSelfDeploy,
  type Heartbeat,
} from "@/lib/lifecycle/classify";
import {
  formatVersion,
  fromVersionLabel,
  isSelfUpdate,
  selfDeployMarker,
  targetVersion,
  writeUpdateMarker,
  type SelfDeployRun,
} from "@/lib/lifecycle/self-deploy";

const NOW = Date.parse("2026-10-09T17:00:00Z");
const OLD = "a1b2c3d4e5f6";
const NEW = "f6e5d4c3b2a1";

const run = (overrides: Partial<SelfDeployRun> = {}): SelfDeployRun => ({
  deploymentId: "dep_123",
  appName: "vardo",
  envIsolated: false,
  envType: "production",
  startTime: NOW - 240_000,
  activeSlot: "blue",
  newSlot: "green",
  gitSha: "4f1a9b2c0d",
  gitBranch: "main",
  ...overrides,
});

const ids = { fromVersion: "0.1.0 (e36c2e3)", toVersion: "0.1.0 (4f1a9b2)", fromHost: OLD };

describe("isSelfUpdate", () => {
  it("is the vardo app's own environment only", () => {
    expect(isSelfUpdate(run())).toBe(true);
    expect(isSelfUpdate(run({ envIsolated: true }))).toBe(false);
    expect(isSelfUpdate(run({ envType: "local" }))).toBe(false);
    expect(isSelfUpdate(run({ appName: "acme-web" }))).toBe(false);
  });
});

describe("targetVersion", () => {
  it("matches versionLabel's format", () => {
    expect(targetVersion('{"version":"0.2.0"}', "4f1a9b2c0d")).toBe("0.2.0 (4f1a9b2)");
    expect(targetVersion(null, "4f1a9b2c0d")).toBe("4f1a9b2");
    expect(targetVersion("not json", null)).toBeUndefined();
  });

  it("leaves out a sha that isn't a commit", () => {
    expect(targetVersion('{"version":"0.2.0"}', "local")).toBe("0.2.0");
  });
});

describe("fromVersionLabel", () => {
  it("prints the build's commit like the target version does", () => {
    const from = fromVersionLabel("0.1.0", "71b4f31c9e", "e36c2e3aa1");
    expect(from).toBe("0.1.0 (71b4f31)");
    expect(from).toBe(targetVersion('{"version":"0.1.0"}', "71b4f31c9e"));
  });

  it("takes the last deploy's commit when the build has none", () => {
    expect(fromVersionLabel("0.1.0", "", "71b4f31c9e")).toBe("0.1.0 (71b4f31)");
    expect(fromVersionLabel("0.1.0", "local", "71b4f31c9e")).toBe("0.1.0 (71b4f31)");
  });

  it("falls back to the package version alone", () => {
    expect(fromVersionLabel("0.1.0", "", null)).toBe("0.1.0");
  });
});

describe("formatVersion", () => {
  it("shortens the sha and drops non-commits", () => {
    expect(formatVersion("0.1.0", "71B4F31C9E")).toBe("0.1.0 (71B4F31)");
    expect(formatVersion("0.1.0", "")).toBe("0.1.0");
    expect(formatVersion(undefined, undefined)).toBeUndefined();
  });
});

describe("selfDeployMarker", () => {
  it("reads back as the marker install.sh writes", () => {
    const marker = selfDeployMarker(run(), { state: "started" }, ids);
    expect(parseUpdateMarker(JSON.stringify(marker))).toMatchObject({
      id: "dep_123",
      kind: "self-deploy",
      state: "started",
      startedAt: NOW - 240_000,
      fromVersion: "0.1.0 (e36c2e3)",
      toVersion: "0.1.0 (4f1a9b2)",
      branch: "main",
      fromSlot: "blue",
      toSlot: "green",
      fromHost: OLD,
    });
  });

  it("reports no console downtime when both slots served through the cutover", () => {
    const marker = selfDeployMarker(run({ healthyAt: NOW - 30_000 }), { state: "updated", finishedAt: NOW }, ids);
    expect(marker).toMatchObject({ finishedAt: NOW, healthyAt: NOW - 30_000, swapStartedAt: NOW - 30_000 });
  });

  it("measures downtime from the old slot's stop when it stopped first", () => {
    const marker = selfDeployMarker(
      run({ oldStoppedAt: NOW - 50_000, healthyAt: NOW - 30_000 }),
      { state: "updated", finishedAt: NOW },
      ids,
    );
    expect(marker.swapStartedAt).toBe(NOW - 50_000);
  });

  it("carries the step, error and log tail on failure", () => {
    const logLines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const marker = selfDeployMarker(
      run({ logLines }),
      { state: "failed", finishedAt: NOW, step: "healthcheck", error: "green slot did not become healthy", rolledBack: true },
      ids,
    );
    expect(marker).toMatchObject({ state: "failed", step: "healthcheck", rolledBack: true });
    expect(marker.logTail).toHaveLength(20);
    expect(marker.logTail?.at(-1)).toBe("line 29");
  });
});

describe("writeUpdateMarker", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes update.json whole, with no temp file left", async () => {
    dir = await mkdtemp(join(tmpdir(), "vardo-lifecycle-"));
    await writeUpdateMarker(selfDeployMarker(run(), { state: "started" }, ids), join(dir, "lifecycle"));
    expect(await readdir(join(dir, "lifecycle"))).toEqual(["update.json"]);
    expect(parseUpdateMarker(await readFile(join(dir, "lifecycle", "update.json"), "utf-8"))?.kind).toBe("self-deploy");
  });
});

describe("who reports a self-deploy", () => {
  const marker = (state: "started" | "updated" | "failed", finishedAt?: number) =>
    parseUpdateMarker(JSON.stringify({ ...selfDeployMarker(run(), { state: "started" }, ids), state, finishedAt }));

  it("leaves the outcome to the new console", () => {
    expect(ranSelfDeploy(marker("updated", NOW), OLD)).toBe(true);
    expect(ranSelfDeploy(marker("updated", NOW), NEW)).toBe(false);
  });

  it("treats an install.sh marker as nobody's self-deploy", () => {
    const install = parseUpdateMarker(JSON.stringify({ id: "20261009", state: "updated", startedAt: 1, fromVersion: "x" }));
    expect(install?.kind).toBe("install");
    expect(ranSelfDeploy(install, OLD)).toBe(false);
  });

  it("calls the old console's stop part of the deploy, for a while", () => {
    expect(stoppingForSelfDeploy(marker("started"), OLD, NOW)).toBe(true);
    expect(stoppingForSelfDeploy(marker("updated", NOW - 60_000), OLD, NOW)).toBe(true);
    expect(stoppingForSelfDeploy(marker("updated", NOW - 60 * 60_000), OLD, NOW)).toBe(false);
    expect(stoppingForSelfDeploy(marker("failed", NOW), OLD, NOW)).toBe(false);
    expect(stoppingForSelfDeploy(marker("updated", NOW), NEW, NOW)).toBe(false);
  });
});

describe("isConsoleHandover", () => {
  const beat = (at: number, host?: string): Heartbeat => ({ at, hostBootAt: null, version: "x", host });

  it("sees another console's fresh heartbeat as a handover", () => {
    expect(isConsoleHandover({ heartbeat: beat(NOW - 10_000, OLD), startedAt: NOW, selfHost: NEW, otherConsoleRunning: false })).toBe(true);
  });

  it("sees its own last heartbeat as a crash", () => {
    expect(isConsoleHandover({ heartbeat: beat(NOW - 10_000, NEW), startedAt: NOW, selfHost: NEW, otherConsoleRunning: false })).toBe(false);
  });

  it("asks Docker when the heartbeat predates hosts", () => {
    expect(isConsoleHandover({ heartbeat: beat(NOW - 10_000), startedAt: NOW, selfHost: NEW, otherConsoleRunning: true })).toBe(true);
    expect(isConsoleHandover({ heartbeat: beat(NOW - 10_000), startedAt: NOW, selfHost: NEW, otherConsoleRunning: false })).toBe(false);
  });

  it("ignores a stale heartbeat", () => {
    expect(isConsoleHandover({ heartbeat: beat(NOW - 10 * 60_000, OLD), startedAt: NOW, selfHost: NEW, otherConsoleRunning: true })).toBe(false);
  });
});

describe("isOtherConsole", () => {
  const container = (id: string, project: string, service = "frontend") => ({
    id: `${id}0000`,
    labels: { "com.docker.compose.project": project, "com.docker.compose.service": service },
  });

  it("matches the legacy and slot consoles other than this one", () => {
    expect(isOtherConsole(container(OLD, "vardo"), NEW)).toBe(true);
    expect(isOtherConsole(container(OLD, "vardo-production-blue"), NEW)).toBe(true);
    expect(isOtherConsole(container(NEW, "vardo-production-green"), NEW)).toBe(false);
  });

  it("skips previews, other services and other apps", () => {
    expect(isOtherConsole(container(OLD, "vardo-pr-12-blue"), NEW)).toBe(false);
    expect(isOtherConsole(container(OLD, "vardo", "postgres"), NEW)).toBe(false);
    expect(isOtherConsole(container(OLD, "acme-web-production-blue"), NEW)).toBe(false);
  });
});
