// Stored git credentials reach git through env config only: never argv, the remote URL or the log.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

process.env.ENCRYPTION_MASTER_KEY ??= "d".repeat(64);

type Call = { args: string[]; env: Record<string, string | undefined> };

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Call[],
  state: { hasRepo: true },
}));

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: { env?: Record<string, string | undefined> },
    cb: (e: Error | null, r?: unknown) => void,
  ) => {
    if (cmd !== "git") return cb(null, { stdout: "", stderr: "" });
    calls.push({ args, env: opts?.env ?? {} });
    let a = args[0] === "-C" ? args.slice(2) : args;
    while (a[0] === "-c") a = a.slice(2);
    if (!state.hasRepo && a[0] === "remote") return cb(Object.assign(new Error("no repo"), { stderr: "not a git repository" }));
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
  assertGitHostAllowed: () => Promise.resolve(),
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => false }));
vi.mock("@/lib/config/host-config", () => ({
  readHostConfig: vi.fn().mockResolvedValue(null),
  applyHostConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/git-integration/app", () => ({ getInstallationToken: vi.fn(), getRepoInstallationId: vi.fn() }));
vi.mock("@/lib/git-integration/org-installations", () => ({
  orgInstallations: vi.fn().mockResolvedValue([]),
  LINK_INSTALLATION_HINT: "",
}));
vi.mock("@/lib/crypto/deploy-key", () => ({
  getDecryptedPrivateKey: vi.fn().mockResolvedValue(null),
  writeTemporaryKeyFile: vi.fn(),
  cleanupKeyFile: vi.fn(),
  buildGitSshCommand: vi.fn(),
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
import { DeployBlockedError } from "@/lib/docker/errors";
import { createStageTimings } from "@/lib/docker/stage-timings";
import { gitUrlColumns } from "@/lib/api/git-credentials";



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

const CLEAN = "https://example.com/acme/web.git";
const SECRET = "tok3n-value";
const basic = Buffer.from(`deploy:${SECRET}`).toString("base64");

const credApp = (cols: { gitUrl: string | null; gitCredentials?: string | null }) =>
  makeApp({ source: "git", deployType: "compose", gitBranch: "main", ...cols });

function expectNoSecretInArgs() {
  expect(calls.length).toBeGreaterThan(0);
  for (const { args } of calls) {
    expect(args.join(" ")).not.toContain(SECRET);
    expect(args.join(" ")).not.toContain("deploy@");
  }
}

function networkCalls() {
  return calls.filter(({ args }) => args.includes("fetch") || args.includes("clone"));
}

describe("prepareRepo with stored git credentials", () => {
  beforeEach(() => {
    calls.length = 0;
    state.hasRepo = true;
  });

  it("rewrites an existing remote to the bare URL and authenticates fetch through env", async () => {
    const { ctx } = makeCtx(credApp(gitUrlColumns(`https://deploy:${SECRET}@example.com/acme/web.git`, "org-1")));
    await prepareRepo(ctx);

    expectNoSecretInArgs();
    const setUrl = calls.find(({ args }) => args.includes("set-url"))!;
    expect(setUrl.args.at(-1)).toBe(CLEAN);
    const fetch = networkCalls()[0];
    expect(fetch.args).toContain("fetch");
    expect(fetch.env.GIT_CONFIG_KEY_0).toBe("http.https://example.com/.extraheader");
    expect(fetch.env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
    expect(ctx.logLines.join("\n")).not.toContain(SECRET);
  });

  it("clones the bare URL when there's no checkout yet", async () => {
    state.hasRepo = false;
    const { ctx } = makeCtx(credApp(gitUrlColumns(`https://deploy:${SECRET}@example.com/acme/web.git`, "org-1")));
    await prepareRepo(ctx);

    expectNoSecretInArgs();
    const clone = networkCalls().find(({ args }) => args.includes("clone"))!;
    expect(clone.args.at(-2)).toBe(CLEAN);
    expect(clone.env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
  });

  it("moves credentials still embedded in a legacy URL out of argv too", async () => {
    const { ctx } = makeCtx(credApp({ gitUrl: `https://deploy:${SECRET}@example.com/acme/web.git`, gitCredentials: null }));
    await prepareRepo(ctx);

    expectNoSecretInArgs();
    expect(networkCalls()[0].env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
  });

  it("sends no auth header for a repo without credentials", async () => {
    const { ctx } = makeCtx(credApp({ gitUrl: CLEAN, gitCredentials: null }));
    await prepareRepo(ctx);
    expect(networkCalls()[0].env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("blocks the deploy when the credentials won't decrypt", async () => {
    const { ctx } = makeCtx(credApp(gitUrlColumns(`https://deploy:${SECRET}@example.com/acme/web.git`, "org-2")));
    await expect(prepareRepo(ctx)).rejects.toThrow(DeployBlockedError);
    expect(calls).toEqual([]);
  });
});
