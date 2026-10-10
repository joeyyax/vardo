// ---------------------------------------------------------------------------
// prepareRepo image reuse: a deploy whose build key matches an earlier deploy's
// retags that image instead of building, unless a rebuild was asked for.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const { dbSets, dockerCalls, localImages, earlier } = vi.hoisted(() => ({
  dbSets: [] as Record<string, unknown>[],
  dockerCalls: [] as string[][],
  localImages: new Set<string>(),
  earlier: { rows: [] as { id: string; buildPlan: unknown }[] },
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd === "docker") {
      dockerCalls.push(args);
      if (args[0] === "image" && args[1] === "inspect" && !localImages.has(args.at(-1)!)) return cb(new Error("No such image"));
      return cb(null, { stdout: "", stderr: "" });
    }
    if (cmd !== "git") return cb(null, { stdout: "", stderr: "" });
    const a = args[0] === "-C" ? args.slice(2) : args;
    if (a[0] === "rev-parse") return cb(null, { stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n", stderr: "" });
    if (a[0] === "log") return cb(null, { stdout: "author\0subject\n", stderr: "" });
    return cb(null, { stdout: "", stderr: "" });
  },
  spawn: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({}),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  readdir: vi.fn().mockResolvedValue(["package.json"]),
}));

vi.mock("@/lib/docker/buildkit", async (orig) => ({
  ...(await orig<typeof import("@/lib/docker/buildkit")>()),
  isBuildKitReachable: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/docker/build-plan", async (orig) => ({
  ...(await orig<typeof import("@/lib/docker/build-plan")>()),
  captureBuildPlan: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/paths", () => ({
  appBaseDir: (name: string) => `/srv/apps/${name}`,
  appEnvDir: (name: string, env?: string) => `/srv/apps/${name}/${env ?? "production"}`,
  PROJECTS_DIR: "/srv/apps",
  VARDO_HOME_DIR: "/srv",
}));
vi.mock("@/lib/docker/app-dir-owner", () => ({ assertAppDirOwnership: vi.fn() }));
vi.mock("@/lib/docker/git-host", async (orig) => ({
  ...(await orig<typeof import("@/lib/docker/git-host")>()),
  assertGitHostAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => false }));
vi.mock("@/lib/config/host-config", () => ({
  readHostConfig: vi.fn().mockResolvedValue(null),
  applyHostConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/git-integration/app", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/crypto/deploy-key", () => ({
  getDecryptedPrivateKey: vi.fn().mockResolvedValue(null),
  writeTemporaryKeyFile: vi.fn(),
  cleanupKeyFile: vi.fn(),
  buildGitSshCommand: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      volumes: { findMany: vi.fn().mockResolvedValue([]) },
      githubInstallationOrgs: { findMany: vi.fn().mockResolvedValue([]) },
      deployments: { findMany: vi.fn(async () => earlier.rows) },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        dbSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));
vi.mock("@/lib/docker/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/constants")>()),
  ensureWritableDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/image-updates/registry", () => ({ getRegistryCredentials: vi.fn().mockResolvedValue({}) }));

import { EventEmitter } from "events";
import { spawn } from "child_process";
import { db } from "@/lib/db";
import { prepareRepo } from "@/lib/docker/deploy-steps/prepare-repo";
import { createStageTimings } from "@/lib/docker/stage-timings";
import { deploymentImageName } from "@/lib/docker/image-tag";

function app(overrides: Partial<DeployApp> = {}): DeployApp {
  return {
    id: "app-1",
    organizationId: "org-1",
    name: "shop",
    displayName: "Shop",
    description: null,
    source: "git",
    deployType: "nixpacks",
    gitUrl: "https://git.example.com/example/shop.git",
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
    cpuLimit: null,
    memoryLimit: null,
    priority: "standard",
    gpuEnabled: false,
    healthCheckTimeout: null,
    autoRollback: null,
    rollbackGracePeriod: null,
    backendProtocol: null,
    envContent: null,
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

function makeCtx(rebuild?: DeployContext["rebuild"]): DeployContext {
  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    return line;
  };
  return {
    deploymentId: "dep-new-1",
    appId: "app-1",
    organizationId: "org-1",
    trigger: "manual",
    rebuild,
    app: app(),
    org: null,
    orgTrusted: false,
    projectAllowBindMounts: false,
    projectAllowDockerSocket: false,
    envName: "production",
    envType: "production",
    envBranchOverride: null,
    envMap: { NEXT_PUBLIC_API: "https://api.example.com" },
    volumesList: [],
    appVolumes: [],
    effectiveSource: "git",
    compose: { services: {} },
    bareCompose: { services: {} },
    serviceConfig: {},
    builtLocally: false,
    builtImageRefs: [],
    hostConfig: null,
    repoDir: null,
    appBase: "",
    appDir: "",
    slotDir: "",
    newProjectName: "",
    activeSlot: null,
    newSlot: "blue",
    isLocalEnv: false,
    containerPort: 0,
    composeFileArgs: [],
    stableVolumePrefix: "",
    log,
    stage: () => {},
    checkAbort: vi.fn(),
    timer: createStageTimings(),
    logs: { push: log },
    logLines,
    startTime: Date.now(),
  };
}

const PREVIOUS = "dep-old-1";
const previousImage = deploymentImageName("shop", PREVIOUS);
const newImage = deploymentImageName("shop", "dep-new-1");

describe("prepareRepo image reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSets.length = 0;
    dockerCalls.length = 0;
    localImages.clear();
    earlier.rows = [{ id: PREVIOUS, buildPlan: { engine: "nixpacks" } }];
    localImages.add(previousImage);
    vi.mocked(spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1 });
      setImmediate(() => proc.emit("close", 0));
      return proc as unknown as ReturnType<typeof spawn>;
    });
  });

  it("retags the earlier image and skips the build when the key matches", async () => {
    const ctx = makeCtx();
    await prepareRepo(ctx);

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(dockerCalls).toContainEqual(["tag", previousImage, newImage]);
    expect(ctx.logLines).toContain("[build] Reused image from deploy dep-old-, nothing build-relevant changed");
    expect(ctx.builtImageRefs).toEqual([newImage]);
    expect(dbSets.find((v) => "buildKey" in v)?.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(dbSets.find((v) => "buildPlan" in v)?.buildPlan).toEqual({ engine: "nixpacks" });
  });

  it("builds when the earlier image is gone from the host", async () => {
    localImages.clear();
    const ctx = makeCtx();
    await prepareRepo(ctx);

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(dockerCalls.some((a) => a[0] === "tag")).toBe(false);
    expect(dbSets.find((v) => "buildKey" in v)?.buildKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds when no earlier deploy has the key", async () => {
    earlier.rows = [];
    const ctx = makeCtx();
    await prepareRepo(ctx);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it("rebuilds with the layer cache on force, without looking for an image", async () => {
    const ctx = makeCtx("force");
    await prepareRepo(ctx);

    expect(vi.mocked(db.query.deployments.findMany)).not.toHaveBeenCalled();
    const [, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(args).not.toContain("--no-cache");
    expect(ctx.logLines).toContain("[build] Rebuilding, as asked");
  });

  it("times the build and BuildKit's export as their own phases", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1 });
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("#7 [3/3] RUN npm run build\n#7 DONE 0.1s\n#9 exporting to im"));
        proc.stdout.emit("data", Buffer.from("age\n#9 DONE 0.01s\n"));
        proc.emit("close", 0);
      }, 40);
      return proc as unknown as ReturnType<typeof spawn>;
    });
    earlier.rows = [];
    const ctx = makeCtx();
    await prepareRepo(ctx);

    const timings = ctx.timer.snapshot();
    expect(timings.export?.ms).toBe(10);
    expect(timings.build?.ms).toBeGreaterThanOrEqual(25);
  });

  it("records no build phase when the image is reused", async () => {
    const ctx = makeCtx();
    await prepareRepo(ctx);
    expect(ctx.timer.snapshot().build).toBeUndefined();
  });

  it("rebuilds without the cache on no-cache", async () => {
    const ctx = makeCtx("no-cache");
    await prepareRepo(ctx);

    expect(vi.mocked(db.query.deployments.findMany)).not.toHaveBeenCalled();
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("nixpacks");
    expect(args).toContain("--no-cache");
  });
});
