// A branch or URL git can read as an option runs commands on the host.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const gitCalls = vi.hoisted(() => [] as string[][]);

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd !== "git") return cb(null, { stdout: "", stderr: "" });
    gitCalls.push(args);
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
  VARDO_HOME_DIR: "/srv",
}));

vi.mock("@/lib/docker/app-dir-owner", () => ({ assertAppDirOwnership: vi.fn() }));
vi.mock("@/lib/docker/git-host", async (orig) => ({
  ...(await orig<typeof import("@/lib/docker/git-host")>()),
  assertGitHostAllowed: (url: string) => (url.includes("internal.test") ? Promise.reject(new Error("Refusing to reach internal.test")) : Promise.resolve()),
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
    update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

vi.mock("@/lib/docker/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/constants")>()),
  ensureWritableDir: vi.fn().mockResolvedValue(undefined),
}));

import { prepareRepo } from "@/lib/docker/deploy-steps/prepare-repo";
import { DeployBlockedError } from "@/lib/docker/errors";
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

const gitApp = (gitBranch: string | null, gitUrl = "https://example.com/acme/web.git") =>
  makeApp({ source: "git", deployType: "compose", gitUrl, gitBranch });

describe("prepareRepo git arguments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitCalls.length = 0;
  });

  it("refuses a branch that starts with a dash", async () => {
    const { ctx } = makeCtx(gitApp("--prune"));
    await expect(prepareRepo(ctx)).rejects.toThrow(DeployBlockedError);
    expect(gitCalls).toEqual([]);
  });

  it("refuses an environment branch override that starts with a dash", async () => {
    const { ctx } = makeCtx(gitApp("main"));
    ctx.envBranchOverride = "-v";
    await expect(prepareRepo(ctx)).rejects.toThrow(DeployBlockedError);
    expect(gitCalls).toEqual([]);
  });

  for (const url of ["/srv/apps/other/repo", "file:///etc", "ext::sh -c touch% /tmp/pwned", "--upload-pack=x"]) {
    it(`refuses the git URL ${url}`, async () => {
      const { ctx } = makeCtx(gitApp("main", url));
      await expect(prepareRepo(ctx)).rejects.toThrow(DeployBlockedError);
      expect(gitCalls).toEqual([]);
    });
  }

  it("refuses a git host the outbound policy blocks", async () => {
    const { ctx } = makeCtx(gitApp("main", "https://internal.test/acme/web.git"));
    await expect(prepareRepo(ctx)).rejects.toThrow(DeployBlockedError);
    expect(gitCalls).toEqual([]);
  });

  it("stops git following redirects on clone and fetch", async () => {
    const { ctx } = makeCtx(gitApp("main"));
    await prepareRepo(ctx);
    for (const verb of ["fetch", "clone"]) {
      const call = gitCalls.find((a) => a.includes(verb));
      if (call) expect(call.join(" ")).toContain("-c http.followRedirects=false");
    }
    expect(gitCalls.some((a) => a.includes("fetch") || a.includes("clone"))).toBe(true);
  });

  it("ends options before the remote, branch and URL", async () => {
    const { ctx } = makeCtx(gitApp("feature/x"));
    await prepareRepo(ctx);
    const fetch = gitCalls.find((a) => a.includes("fetch"))!;
    expect(fetch.slice(fetch.indexOf("fetch") + 1)).toEqual(["--", "origin", "feature/x"]);
    const setUrl = gitCalls.find((a) => a.includes("set-url"))!;
    expect(setUrl.slice(setUrl.indexOf("set-url") + 1)).toEqual(["--", "origin", "https://example.com/acme/web.git"]);
  });
});
