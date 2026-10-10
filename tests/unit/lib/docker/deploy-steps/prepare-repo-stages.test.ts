// ---------------------------------------------------------------------------
// prepareRepo stage transitions. The header spins on whatever phase is left
// open, so every path out of the step has to close the clone stage the
// orchestrator opened before it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const { dbSets, nixpacksPlan } = vi.hoisted(() => ({
  dbSets: [] as Record<string, unknown>[],
  nixpacksPlan: { stdout: "" },
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd === "nixpacks" && args[0] === "plan") return cb(null, { stdout: nixpacksPlan.stdout, stderr: "" });
    if (cmd !== "git") return cb(null, { stdout: "", stderr: "" });
    const a = args[0] === "-C" ? args.slice(2) : args;
    if (a[0] === "rev-parse") return cb(null, { stdout: "abc1234\n", stderr: "" });
    if (a[0] === "log") return cb(null, { stdout: "commit subject\n", stderr: "" });
    return cb(null, { stdout: "", stderr: "" });
  },
  spawn: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("services:\n  web:\n    image: nginx:1.27\n"),
  readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/docker/buildkit", async (orig) => ({
  ...(await orig<typeof import("@/lib/docker/buildkit")>()),
  isBuildKitReachable: vi.fn().mockResolvedValue(false),
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
vi.mock("@/lib/crypto/encrypt", () => ({
  decrypt: vi.fn(),
  decryptOrFallback: vi.fn().mockReturnValue({ content: "", wasEncrypted: true }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      volumes: { findMany: vi.fn().mockResolvedValue([]) },
      githubInstallationOrgs: { findMany: vi.fn().mockResolvedValue([]) },
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
import { readFile, readdir } from "fs/promises";
import { prepareRepo } from "@/lib/docker/deploy-steps/prepare-repo";
import { createStageTimings } from "@/lib/docker/stage-timings";

const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n";

function makeApp(overrides: Partial<DeployApp>): DeployApp {
  return {
    id: "app-1",
    organizationId: "org-1",
    name: "plex",
    displayName: "Plex",
    description: null,
    source: "direct",
    deployType: "compose",
    gitUrl: null,
    gitBranch: null,
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

type StageCall = [string, string];

function makeCtx(app: DeployApp): { ctx: DeployContext; stages: StageCall[] } {
  const stages: StageCall[] = [];
  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    return line;
  };
  const ctx: DeployContext = {
    deploymentId: "dep-1",
    appId: "app-1",
    organizationId: "org-1",
    trigger: "manual",
    app,
    org: null,
    orgTrusted: false,
    projectAllowBindMounts: false,
    projectAllowDockerSocket: false,
    envName: "production",
    envType: "production",
    envBranchOverride: null,
    envMap: {},
    volumesList: [],
    appVolumes: [],
    effectiveSource: app.source,
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
    stage: (s, status) => {
      stages.push([s, status]);
    },
    checkAbort: vi.fn(),
    timer: createStageTimings(),
    logs: { push: log },
    logLines,
    startTime: Date.now(),
  };
  return { ctx, stages };
}

/** The status the step left on a phase, or undefined if it never touched it. */
function finalStatus(stages: StageCall[], key: string): string | undefined {
  return stages.filter(([s]) => s === key).at(-1)?.[1];
}

describe("prepareRepo stage transitions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes clone for a direct-source compose app", async () => {
    const { ctx, stages } = makeCtx(makeApp({ source: "direct", deployType: "compose", composeContent: COMPOSE }));

    await prepareRepo(ctx);

    expect(finalStatus(stages, "clone")).toBe("skipped");
    expect(finalStatus(stages, "compose")).toBe("running");
  });

  it("skips clone for an image app", async () => {
    const { ctx, stages } = makeCtx(makeApp({ source: "image", deployType: "image", imageName: "nginx:1.27" }));

    await prepareRepo(ctx);

    expect(finalStatus(stages, "clone")).toBe("skipped");
    expect(finalStatus(stages, "compose")).toBe("running");
  });

  it("completes clone for a git app", async () => {
    const { ctx, stages } = makeCtx(
      makeApp({ source: "git", deployType: "compose", gitUrl: "https://git.example.com/example/api.git", gitBranch: "main" }),
    );

    await prepareRepo(ctx);

    expect(finalStatus(stages, "clone")).toBe("success");
    expect(finalStatus(stages, "compose")).toBe("running");
  });

  it("passes app env vars to Nixpacks only as --env flags", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1 });
      setImmediate(() => proc.emit("close", 0));
      return proc as unknown as ReturnType<typeof spawn>;
    });
    const { ctx } = makeCtx(
      makeApp({ source: "git", deployType: "nixpacks", gitUrl: "https://git.example.com/example/api.git", gitBranch: "main" }),
    );
    ctx.envMap = { LD_PRELOAD: "/srv/apps/plex/repo/evil.so" };

    await prepareRepo(ctx);

    const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(cmd).toBe("nixpacks");
    expect(args).toContain("LD_PRELOAD=/srv/apps/plex/repo/evil.so");
    expect(opts.env.LD_PRELOAD).toBeUndefined();
  });
});

describe("buildpack detection, plan and overrides", () => {
  const plan = readFileSync(join(__dirname, "../fixtures/buildpack/nix-plan-node.json"), "utf8");
  const gitApp = (overrides: Partial<DeployApp> = {}) =>
    makeApp({ source: "git", deployType: "compose", gitUrl: "https://git.example.com/example/api.git", gitBranch: "main", ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
    dbSets.length = 0;
    nixpacksPlan.stdout = plan;
    // No compose file and no Dockerfile.
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    vi.mocked(readdir).mockResolvedValue(["Procfile", "README.md", "package.json"] as never);
    vi.mocked(spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1 });
      setImmediate(() => proc.emit("close", 0));
      return proc as unknown as ReturnType<typeof spawn>;
    });
  });

  afterEach(() => {
    vi.mocked(readFile).mockResolvedValue(COMPOSE);
    vi.mocked(readdir).mockResolvedValue([] as never);
  });

  it("names the files and the reason when it falls back to a buildpack", async () => {
    const { ctx } = makeCtx(gitApp());

    await prepareRepo(ctx);

    expect(ctx.logLines).toContain(
      "[deploy] No compose file or Dockerfile, found Procfile, package.json (node) — building with Nixpacks (BuildKit not reachable)",
    );
  });

  it("uses the builder set in build settings over auto-detection", async () => {
    const { ctx } = makeCtx(gitApp({ buildProvider: "nixpacks" }));

    await prepareRepo(ctx);

    expect(ctx.logLines.some((l) => l.endsWith("building with Nixpacks (set in build settings)"))).toBe(true);
  });

  it("stores the plan on the deployment and logs its summary", async () => {
    const { ctx } = makeCtx(gitApp());

    await prepareRepo(ctx);

    const stored = dbSets.find((v) => "buildPlan" in v)?.buildPlan as { engine: string; summary: { providers: string[]; evidence: string[] } };
    expect(stored.engine).toBe("nixpacks");
    expect(stored.summary.providers).toEqual(["node"]);
    expect(stored.summary.evidence).toEqual(["Procfile", "package.json"]);
    expect(ctx.logLines).toContain("[build] Plan from Nixpacks: node");
    expect(ctx.logLines).toContain("[build]   Start: node index.js");
  });

  it("threads build and start overrides into the build", async () => {
    const { ctx } = makeCtx(gitApp({ deployType: "nixpacks", buildCommand: "npm run custom", startCommand: "node custom.js" }));

    await prepareRepo(ctx);

    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("nixpacks");
    expect(args).toEqual(expect.arrayContaining(["--build-cmd", "npm run custom", "--start-cmd", "node custom.js"]));
  });

  it("still builds when the plan can't be read", async () => {
    nixpacksPlan.stdout = "";
    const { ctx } = makeCtx(gitApp({ deployType: "nixpacks" }));

    await prepareRepo(ctx);

    expect(dbSets.some((v) => "buildPlan" in v)).toBe(false);
    expect(ctx.logLines).toContain("[build] Couldn't read the Nixpacks plan: output wasn't JSON");
    expect(vi.mocked(spawn)).toHaveBeenCalled();
  });
});
