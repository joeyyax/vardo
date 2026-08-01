// ---------------------------------------------------------------------------
// prepareRepo wiring for rollback deploys: the clone must end up on the target
// commit, not the branch tip. Unit tests on checkoutRollbackSha can't catch a
// step that never calls it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const { SHA, TIP, gitCalls, gitRouter } = vi.hoisted(() => {
  const TIP = "ffffffffffffffffffffffffffffffffffffffff";
  return {
    SHA: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    TIP,
    gitCalls: [] as string[][],
    // Commits the fake repo can resolve. Tests mutate this.
    gitRouter: { present: new Set<string>(), fetchable: new Set<string>(), head: TIP },
  };
});

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd !== "git") return cb(null, { stdout: "", stderr: "" });
    gitCalls.push(args);
    // Strip the `-C <repoDir>` prefix the step adds.
    const a = args[0] === "-C" ? args.slice(2) : args;

    if (a[0] === "cat-file") {
      const sha = a[2].replace("^{commit}", "");
      if (!gitRouter.present.has(sha)) return cb(new Error("not a valid object name"));
      return cb(null, { stdout: "", stderr: "" });
    }
    if (a[0] === "fetch" && a.includes("origin") && gitRouter.fetchable.has(a[a.length - 1])) {
      gitRouter.present.add(a[a.length - 1]);
      return cb(null, { stdout: "", stderr: "" });
    }
    if (a[0] === "fetch" && a[a.length - 1] !== "origin") return cb(new Error("could not fetch"));
    if (a[0] === "checkout") {
      gitRouter.head = a[a.length - 1];
      return cb(null, { stdout: "", stderr: "" });
    }
    if (a[0] === "rev-parse") return cb(null, { stdout: `${gitRouter.head}\n`, stderr: "" });
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

const { deploymentUpdate } = vi.hoisted(() => ({ deploymentUpdate: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      volumes: { findMany: vi.fn().mockResolvedValue([]) },
      memberships: { findMany: vi.fn().mockResolvedValue([]) },
      githubAppInstallations: { findMany: vi.fn().mockResolvedValue([]) },
    },
    update: () => ({ set: (v: unknown) => ({ where: () => deploymentUpdate(v) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

vi.mock("@/lib/docker/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/constants")>()),
  ensureWritableDir: vi.fn().mockResolvedValue(undefined),
}));

import { prepareRepo } from "@/lib/docker/deploy-steps/prepare-repo";

function makeApp(): DeployApp {
  return {
    id: "app-1",
    organizationId: "org-1",
    name: "api",
    displayName: "API",
    description: null,
    source: "git",
    deployType: "compose",
    gitUrl: "https://git.example.com/example/api.git",
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
  };
}

function makeCtx(rollback?: DeployContext["rollback"]): DeployContext {
  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    return line;
  };
  return {
    deploymentId: "dep-new",
    appId: "app-1",
    organizationId: "org-1",
    trigger: rollback ? "rollback" : "manual",
    rollback,
    app: makeApp(),
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
    stage: vi.fn(),
    checkAbort: vi.fn(),
    logs: { push: log },
    logLines,
    startTime: Date.now(),
  };
}

beforeEach(() => {
  gitCalls.length = 0;
  gitRouter.present = new Set([TIP]);
  gitRouter.fetchable = new Set();
  gitRouter.head = TIP;
  deploymentUpdate.mockClear();
});

describe("prepareRepo — rollback", () => {
  it("leaves the clone on the branch tip for a normal deploy", async () => {
    await prepareRepo(makeCtx());

    expect(gitCalls.some((c) => c.includes("checkout"))).toBe(false);
    expect(deploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({ gitSha: TIP }));
  });

  it("checks out the target commit and records it on the new deployment", async () => {
    gitRouter.fetchable = new Set([SHA]);

    await prepareRepo(makeCtx({ targetDeploymentId: "dep-old", gitSha: SHA }));

    expect(gitCalls).toContainEqual(expect.arrayContaining(["checkout", "--force", "--detach", SHA]));
    expect(deploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({ gitSha: SHA }));
  });

  it("fails the deploy when the target commit can't be resolved", async () => {
    await expect(
      prepareRepo(makeCtx({ targetDeploymentId: "dep-old", gitSha: SHA })),
    ).rejects.toThrow(/not available in the repository/);

    expect(gitCalls.some((c) => c.includes("checkout"))).toBe(false);
  });

  it("fails the deploy when the target has no recorded sha", async () => {
    await expect(
      prepareRepo(makeCtx({ targetDeploymentId: "dep-old", gitSha: null })),
    ).rejects.toThrow(/no recorded git SHA/);
  });
});
