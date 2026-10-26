// ---------------------------------------------------------------------------
// prepareRepo image reuse: a deploy whose build key matches an earlier deploy's
// retags that image instead of building, unless a rebuild was asked for.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

const { dbSets, dockerCalls, localImages, earlier, nixpacks } = vi.hoisted(() => ({
  dbSets: [] as Record<string, unknown>[],
  dockerCalls: [] as string[][],
  localImages: new Set<string>(),
  earlier: { rows: [] as { id: string; buildPlan: unknown }[] },
  nixpacks: { generates: false, calls: [] as string[][] },
}));

vi.mock("ioredis", async () => (await import("@/tests/helpers/mocks")).ioredisModule());
vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd === "docker") {
      dockerCalls.push(args);
      if (args[0] === "image" && args[1] === "inspect" && !localImages.has(args.at(-1)!)) return cb(new Error("No such image"));
      return cb(null, { stdout: "", stderr: "" });
    }
    if (cmd === "nixpacks") {
      nixpacks.calls.push(args);
      const plan = nixpacks.generates && args[0] === "plan"
        ? JSON.stringify({ variables: { NODE_ENV: "production", NEXT_PUBLIC_API: "https://api.example.com" } })
        : "";
      return cb(null, { stdout: plan, stderr: "" });
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
  readFile: vi.fn(async (path: string) => {
    if (nixpacks.generates && path.endsWith(".nixpacks/Dockerfile")) return "FROM ghcr.io/railwayapp/nixpacks:ubuntu\n";
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
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

const { remote } = vi.hoisted(() => ({
  remote: { on: false, registry: true, pushed: [] as string[], offered: [] as (string[] | undefined)[] },
}));
const TARGET = {
  id: "lh", kind: "ssh" as const, name: "Long House", host: "10.99.0.2", port: 22, user: "vardo",
  privateKey: "k", hostKey: "10.99.0.2 ssh-ed25519 AAAA", maxConcurrent: 1,
};
vi.mock("@/lib/docker/build-targets", async (orig) => {
  const real = await orig<typeof import("@/lib/docker/build-targets")>();
  return {
    ...real,
    configuredTargets: async () => (remote.on ? [TARGET] : []),
    onTarget: (t: typeof TARGET, run: Parameters<typeof real.onTarget>[1]) =>
      real.onTarget(t, run, async () => ({ env: { DOCKER_HOST: "ssh://vardo@10.99.0.2:22", PATH: "/s/bin:/usr/bin" }, close: async () => {} })),
  };
});
vi.mock("@/lib/docker/build-gate", async (orig) => {
  const real = await orig<typeof import("@/lib/docker/build-gate")>();
  return {
    ...real,
    withBuildSlot: (gate: Parameters<typeof real.withBuildSlot>[0], bounded: Parameters<typeof real.withBuildSlot>[1], build: Parameters<typeof real.withBuildSlot>[2]) => {
      remote.offered.push(gate.targets?.map((t) => t.id));
      return remote.on && gate.targets?.length ? build({ target: gate.targets[0] }) : real.withBuildSlot(gate, bounded, build);
    },
  };
});
vi.mock("@/lib/docker/registry-auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/docker/registry-auth")>()),
  buildRegistryOps: async () =>
    remote.on && remote.registry
      ? {
          ref: (repo: string, key: string) => `reg.example.com/${repo}:${key}`,
          pull: async () => false,
          push: async (local: string) => (remote.pushed.push(local), true),
          untag: async () => {},
        }
      : null,
}));

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
    nixpacks.generates = false;
    nixpacks.calls.length = 0;
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

  it("builds Nixpacks from its generated Dockerfile with docker build", async () => {
    earlier.rows = [];
    nixpacks.generates = true;
    const ctx = makeCtx();
    await prepareRepo(ctx);

    const generate = nixpacks.calls.find((a) => a[0] === "build");
    expect(generate).toEqual(expect.arrayContaining(["--out", "--cache-key", "app-1"]));
    const [cmd, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("docker");
    expect(args[args.indexOf("-f") + 1]).toMatch(/\.nixpacks\/Dockerfile$/);
    expect(args).toContain("NODE_ENV=production");
    expect(args.some((a) => a.startsWith("VARDO_GIT_SHA="))).toBe(false);
    expect(ctx.logLines).toContain("[build] Building with Nixpacks (generated Dockerfile)...");
  });

  it("falls back to Nixpacks' own build when generating the Dockerfile fails", async () => {
    earlier.rows = [];
    const ctx = makeCtx();
    await prepareRepo(ctx);

    const [cmd] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("nixpacks");
    expect(ctx.logLines.some((l) => l.startsWith("[build] Couldn't generate the Nixpacks Dockerfile"))).toBe(true);
  });

  describe("with a build target", () => {
    beforeEach(() => {
      Object.assign(remote, { on: true, registry: true, pushed: [], offered: [] });
      earlier.rows = [];
    });

    afterEach(() => {
      remote.on = false;
    });

    it("builds the generated Dockerfile there and pulls the image here instead of pushing it again", async () => {
      nixpacks.generates = true;
      const ctx = makeCtx();
      await prepareRepo(ctx);

      const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(cmd).toBe("docker");
      expect(opts.env.DOCKER_HOST).toBe("ssh://vardo@10.99.0.2:22");
      expect(opts.env.BUILDX_BUILDER).toBeUndefined();
      expect(args).not.toContain("--output");
      const ref = dockerCalls.find((a) => a[0] === "push")?.[2];
      expect(ref).toMatch(/^reg\.example\.com\/shop:[0-9a-f]{64}$/);
      expect(dockerCalls).toContainEqual(["pull", "--quiet", ref]);
      expect(dockerCalls).toContainEqual(["tag", ref, newImage]);
      expect(remote.pushed).toEqual([]);
      expect(ctx.builtImageRefs).toEqual([newImage]);
    });

    it("copies the image here over SSH when there's no build registry", async () => {
      remote.registry = false;
      nixpacks.generates = true;
      const { PassThrough } = await import("stream");
      const ran: { args: string[]; host?: string }[] = [];
      vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        ran.push({ args, host: opts.env.DOCKER_HOST });
        const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined });
        if (args[0] === "save") setImmediate(() => { proc.stdout.end(Buffer.alloc(4096)); proc.emit("close", 0); });
        else if (args[0] === "load") proc.stdin.on("finish", () => proc.emit("close", 0)).resume();
        else setImmediate(() => proc.emit("close", 0));
        return proc;
      }) as unknown as typeof spawn);
      const ctx = makeCtx();
      await prepareRepo(ctx);

      expect(ran.map((r) => `${r.host ?? "here"} ${r.args[0]}`)).toEqual([
        "ssh://vardo@10.99.0.2:22 build",
        "ssh://vardo@10.99.0.2:22 save",
        "here load",
      ]);
      expect(ran[1].args).toEqual(["save", newImage]);
      expect(dockerCalls.some((a) => a[0] === "push" || a[0] === "pull")).toBe(false);
      expect(dockerCalls).toContainEqual(["image", "rm", newImage]);
      expect(ctx.logLines).toContain(`[build] Copying ${newImage} from Long House over SSH`);
      expect(ctx.logLines).toContainEqual(expect.stringMatching(new RegExp(`^\\[build\\] Copied ${newImage} from Long House over SSH \\(4 KB, `)));
      expect(ctx.builtImageRefs).toEqual([newImage]);
    });

    it("keeps Nixpacks' own build here and doesn't push it", async () => {
      const ctx = makeCtx();
      await prepareRepo(ctx);
      const [cmd, , opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(cmd).toBe("nixpacks");
      expect(opts.env.DOCKER_HOST).toBeUndefined();
      expect(remote.offered).toEqual([undefined]);
      expect(remote.pushed).toEqual([]);
      expect(dockerCalls.some((a) => a[0] === "push")).toBe(false);
    });
  });
});

describe("prepareRepo deploy variables at build time", () => {
  const SHA = "abc1234abc1234abc1234abc1234abc1234abc12";

  beforeEach(() => {
    vi.clearAllMocks();
    dbSets.length = 0;
    earlier.rows = [];
    localImages.clear();
    nixpacks.generates = false;
    vi.mocked(spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1 });
      setImmediate(() => proc.emit("close", 0));
      return proc as unknown as ReturnType<typeof spawn>;
    });
  });

  const keyOf = async (ctx: DeployContext) => {
    dbSets.length = 0;
    await prepareRepo(ctx);
    return dbSets.find((v) => "buildKey" in v)?.buildKey;
  };

  it("gives the build the commit and branch, and nothing that changes per deploy", async () => {
    await prepareRepo(makeCtx());
    const [, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain(`VARDO_GIT_SHA=${SHA}`);
    expect(args).toContain("VARDO_GIT_BRANCH=main");
    expect(args.join(" ")).not.toMatch(/VARDO_DEPLOY_ID|VARDO_DEPLOYED_AT|VARDO_SLOT/);
  });

  it("keeps the app's own value", async () => {
    const ctx = makeCtx();
    ctx.envMap.VARDO_GIT_BRANCH = "release";
    await prepareRepo(ctx);
    const [, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain("VARDO_GIT_BRANCH=release");
    expect(args).not.toContain("VARDO_GIT_BRANCH=main");
  });

  it("keys the same build the same way across deploys", async () => {
    expect(await keyOf({ ...makeCtx(), deploymentId: "dep-a" })).toBe(await keyOf({ ...makeCtx(), deploymentId: "dep-b" }));
  });

  it("keys a branch apart from another at the same commit", async () => {
    expect(await keyOf({ ...makeCtx(), envBranchOverride: "preview" })).not.toBe(await keyOf(makeCtx()));
  });
});
