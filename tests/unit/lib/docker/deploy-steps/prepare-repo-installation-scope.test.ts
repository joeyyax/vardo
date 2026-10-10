// Clone tokens come only from installations linked to the app's org, not from another org of the same user (#788).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const { cloneEnvs, linked, getInstallationToken } = vi.hoisted(() => ({
  cloneEnvs: [] as Record<string, string | undefined>[],
  linked: new Map<string, { installationId: number; accountLogin: string }[]>(),
  getInstallationToken: vi.fn(async (id: number) => `tok-${id}`),
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }, cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd !== "git") return cb(null, { stdout: "", stderr: "" });
    let a = args[0] === "-C" ? args.slice(2) : args;
    while (a[0] === "-c") a = a.slice(2);
    if (a[0] === "remote") return cb(Object.assign(new Error("no repo"), { stderr: "not a git repository" }));
    if (a[0] === "clone") {
      cloneEnvs.push(opts.env ?? {});
      // Private repo: only an auth header gets through.
      if (!opts.env?.GIT_CONFIG_VALUE_0) return cb(Object.assign(new Error("clone failed"), { stderr: "fatal: could not read Username" }));
    }
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
vi.mock("@/lib/docker/git-host", async (orig) => ({
  ...(await orig<typeof import("@/lib/docker/git-host")>()),
  assertGitHostAllowed: () => Promise.resolve(),
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => false }));
vi.mock("@/lib/config/host-config", () => ({
  readHostConfig: vi.fn().mockResolvedValue(null),
  applyHostConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/git-integration/app", () => ({
  getInstallationToken,
  // The vardo-gh installation covers acme/private-site.
  getRepoInstallationId: vi.fn(async () => 2),
}));
vi.mock("@/lib/git-integration/org-installations", async (original) => ({
  ...(await original<typeof import("@/lib/git-integration/org-installations")>()),
  orgInstallations: async (orgId: string) => linked.get(orgId) ?? [],
}));
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
    query: { volumes: { findMany: vi.fn().mockResolvedValue([]) } },
    update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));
vi.mock("@/lib/docker/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/constants")>()),
  ensureWritableDir: vi.fn().mockResolvedValue(undefined),
}));

import { prepareRepo } from "@/lib/docker/deploy-steps/prepare-repo";
import { createStageTimings } from "@/lib/docker/stage-timings";

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

const privateApp = (organizationId: string) =>
  makeApp({ organizationId, source: "git", deployType: "compose", gitUrl: "https://github.com/acme/private-site.git", gitBranch: "main" });

function ctxFor(organizationId: string) {
  const { ctx } = makeCtx(privateApp(organizationId));
  ctx.organizationId = organizationId;
  return ctx;
}

describe("prepareRepo clone installation scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneEnvs.length = 0;
    linked.clear();
    // One user, two orgs: each org has its own installation linked.
    linked.set("org-ops", [{ installationId: 1, accountLogin: "ops-gh" }]);
    linked.set("org-vardo", [{ installationId: 2, accountLogin: "vardo-gh" }]);
  });

  it("clones with the installation linked to the app's org", async () => {
    await prepareRepo(ctxFor("org-vardo"));

    expect(getInstallationToken).toHaveBeenCalledWith(2);
    expect(cloneEnvs[0].GIT_CONFIG_VALUE_0).toBeDefined();
  });

  it("refuses another org's installation and says how to link one", async () => {
    linked.set("org-ops", []);

    const err = await prepareRepo(ctxFor("org-ops")).catch((e) => e);

    expect(getInstallationToken).not.toHaveBeenCalledWith(2);
    expect(cloneEnvs[0].GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("User settings → Connections → GitHub");
  });

  it("doesn't fall back to an org's unrelated installation for a repo it doesn't cover", async () => {
    getInstallationToken.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error("not installed on acme/private-site");
      return `tok-${id}`;
    });

    const err = await prepareRepo(ctxFor("org-ops")).catch((e) => e);

    expect(getInstallationToken).not.toHaveBeenCalledWith(2);
    expect(err.message).toContain("without a GitHub token");
  });
});
