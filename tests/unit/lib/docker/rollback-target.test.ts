import { describe, it, expect, vi } from "vitest";
import type { DeployApp } from "@/lib/docker/deploy-context";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";

vi.mock("@/lib/db", () => ({ db: { query: { deployments: { findFirst: vi.fn() } } } }));

import {
  loadRollbackTarget,
  applyRollbackTarget,
  applyRollbackEnv,
  type RollbackTarget,
} from "@/lib/docker/rollback-target";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function makeApp(overrides: Partial<DeployApp> = {}): DeployApp {
  return {
    id: "app-1",
    organizationId: "org-1",
    name: "api",
    displayName: "API",
    description: null,
    source: "git",
    deployType: "compose",
    gitUrl: "https://github.com/example/api",
    gitBranch: "main",
    gitKeyId: null,
    imageName: null,
    composeContent: null,
    composeFilePath: null,
    dockerfilePath: null,
    rootDirectory: null,
    autoTraefikLabels: true,
    containerPort: 3000,
    autoDeploy: true,
    exposedPorts: null,
    restartPolicy: "unless-stopped",
    projectId: "project-1",
    templateName: null,
    status: "active",
    needsRedeploy: false,
    cpuLimit: 4,
    memoryLimit: 4096,
    priority: "standard",
    gpuEnabled: false,
    healthCheckTimeout: null,
    autoRollback: null,
    rollbackGracePeriod: null,
    backendProtocol: null,
    envContent: "current-env-blob",
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    importedComposeProject: null,
    configSource: null,
    domains: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    cpuLimit: 1,
    memoryLimit: 512,
    gpuEnabled: false,
    containerPort: 8080,
    imageName: null,
    gitBranch: "release",
    composeFilePath: "deploy/compose.yml",
    rootDirectory: "apps/api",
    restartPolicy: "always",
    autoTraefikLabels: false,
    backendProtocol: "https",
    ...overrides,
  };
}

function makeTarget(overrides: Partial<RollbackTarget> = {}): RollbackTarget {
  return {
    targetDeploymentId: "dep-old",
    gitSha: SHA,
    config: makeSnapshot(),
    envSnapshot: "snapshot-env-blob",
    includeEnvVars: false,
    ...overrides,
  };
}

describe("loadRollbackTarget", () => {
  it("throws when the deployment doesn't belong to the app", async () => {
    await expect(loadRollbackTarget("app-1", "dep-old", false, async () => null)).rejects.toThrow(
      /not found for this app/,
    );
  });

  it("throws when the target deployment didn't succeed", async () => {
    const load = async () => ({
      id: "dep-old",
      status: "failed",
      gitSha: SHA,
      envSnapshot: null,
      configSnapshot: null,
    });
    await expect(loadRollbackTarget("app-1", "dep-old", false, load)).rejects.toThrow(/"failed"/);
  });

  it("returns the snapshots for a successful deployment", async () => {
    const config = makeSnapshot();
    const load = async () => ({
      id: "dep-old",
      status: "success",
      gitSha: SHA,
      envSnapshot: "blob",
      configSnapshot: config,
    });

    const target = await loadRollbackTarget("app-1", "dep-old", true, load);

    expect(target).toEqual({
      targetDeploymentId: "dep-old",
      gitSha: SHA,
      config,
      envSnapshot: "blob",
      includeEnvVars: true,
    });
  });
});

describe("applyRollbackTarget", () => {
  it("takes config from the snapshot, not the app row", () => {
    const app = makeApp();

    applyRollbackTarget(app, makeTarget(), vi.fn());

    expect(app.cpuLimit).toBe(1);
    expect(app.memoryLimit).toBe(512);
    expect(app.containerPort).toBe(8080);
    expect(app.gitBranch).toBe("release");
    expect(app.composeFilePath).toBe("deploy/compose.yml");
    expect(app.rootDirectory).toBe("apps/api");
    expect(app.restartPolicy).toBe("always");
    expect(app.autoTraefikLabels).toBe(false);
    expect(app.backendProtocol).toBe("https");
  });

  it("restores snapshotted compose content for direct apps", () => {
    const app = makeApp({ source: "direct", gitUrl: null, composeContent: "services:\n  web:\n    image: new\n" });
    const target = makeTarget({
      gitSha: null,
      config: makeSnapshot({ composeContent: "services:\n  web:\n    image: old\n" }),
    });

    applyRollbackTarget(app, target, vi.fn());

    expect(app.composeContent).toContain("image: old");
  });

  it("warns rather than failing when a direct app has no compose snapshot", () => {
    const app = makeApp({ source: "direct", gitUrl: null, composeContent: "services: {}" });
    const log = vi.fn();

    applyRollbackTarget(app, makeTarget({ gitSha: null }), log);

    expect(log.mock.calls.flat().join("\n")).toMatch(/no compose snapshot/);
  });

  it("throws when a git app's target has no recorded sha", () => {
    const app = makeApp();

    expect(() => applyRollbackTarget(app, makeTarget({ gitSha: null }), vi.fn())).toThrow(
      /no recorded git SHA/,
    );
  });

  it("pins image apps to the snapshotted digest", () => {
    const app = makeApp({ source: "image", deployType: "image", imageName: "ghcr.io/example/api:latest" });
    const target = makeTarget({
      gitSha: null,
      config: makeSnapshot({
        imageName: "ghcr.io/example/api:latest",
        imageDigest: "ghcr.io/example/api@sha256:deadbeef",
      }),
    });

    applyRollbackTarget(app, target, vi.fn());

    expect(app.imageName).toBe("ghcr.io/example/api@sha256:deadbeef");
  });

  it("falls back to the snapshotted tag when no digest was recorded", () => {
    const app = makeApp({ source: "image", deployType: "image", imageName: "ghcr.io/example/api:latest" });
    const target = makeTarget({ gitSha: null, config: makeSnapshot({ imageName: "ghcr.io/example/api:v1" }) });
    const log = vi.fn();

    applyRollbackTarget(app, target, log);

    expect(app.imageName).toBe("ghcr.io/example/api:v1");
    expect(log.mock.calls.flat().join("\n")).toMatch(/no image digest recorded/);
  });

  it("throws when an image app's target records no image at all", () => {
    const app = makeApp({ source: "image", deployType: "image", imageName: "ghcr.io/example/api:latest" });

    expect(() =>
      applyRollbackTarget(app, makeTarget({ gitSha: null, config: null }), vi.fn()),
    ).toThrow(/no recorded image/);
  });
});

describe("applyRollbackEnv", () => {
  it("swaps in the snapshotted env blob when requested", () => {
    const app = makeApp();

    applyRollbackEnv(app, makeTarget({ includeEnvVars: true }), vi.fn());

    expect(app.envContent).toBe("snapshot-env-blob");
  });

  it("leaves current env alone by default", () => {
    const app = makeApp();

    applyRollbackEnv(app, makeTarget(), vi.fn());

    expect(app.envContent).toBe("current-env-blob");
  });
});
