// ---------------------------------------------------------------------------
// prepareRepo stage transitions. The header spins on whatever phase is left
// open, so every path out of the step has to close the clone stage the
// orchestrator opened before it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
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
}));

vi.mock("@/lib/paths", () => ({
  appBaseDir: (name: string) => `/srv/apps/${name}`,
  appEnvDir: (name: string, env?: string) => `/srv/apps/${name}/${env ?? "production"}`,
  PROJECTS_DIR: "/srv/apps",
}));

vi.mock("@/lib/docker/app-dir-owner", () => ({ assertAppDirOwnership: vi.fn() }));
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
      memberships: { findMany: vi.fn().mockResolvedValue([]) },
      githubAppInstallations: { findMany: vi.fn().mockResolvedValue([]) },
    },
    update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

vi.mock("@/lib/docker/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/constants")>()),
  ensureWritableDir: vi.fn().mockResolvedValue(undefined),
}));

import { prepareRepo } from "@/lib/docker/deploy-steps/prepare-repo";

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
});
