import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// runDeployment — the app's Build cache setting reaches every deploy path.
// ---------------------------------------------------------------------------

const { dbMock, state } = vi.hoisted(() => {
  const state: {
    buildCache: string;
    envs: Record<string, unknown>[];
    rebuild?: string;
    logs: string[];
  } = { buildCache: "use", envs: [], logs: [] };

  const dbMock = {
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
    query: {
      apps: {
        findFirst: vi.fn(async () => ({
          id: "app-1",
          name: "notes-api",
          displayName: "Notes",
          organizationId: "org-1",
          projectId: null,
          source: "git",
          deployType: "dockerfile",
          envContent: null,
          containerPort: null,
          buildCache: state.buildCache,
          domains: [],
        })),
      },
      domains: { findMany: vi.fn().mockResolvedValue([]) },
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: "org-1", name: "Org", baseDomain: "example.com", trusted: false }) },
      projects: { findFirst: vi.fn().mockResolvedValue(null) },
      environments: {
        findFirst: vi.fn(async () => state.envs.shift() ?? null),
        findMany: vi.fn(async () => []),
      },
      environmentEnv: { findFirst: vi.fn().mockResolvedValue({ envContent: "" }) },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn().mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };

  return { dbMock, state };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/domains/routable", () => ({ splitRoutable: async (rows: unknown[]) => ({ routable: rows, dropped: [] }) }));
vi.mock("@/lib/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("1-0") }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/docker/deploy-logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/deploy-logger")>()),
  createDeployLogger: () => ({
    addSecrets: vi.fn(), addPublicNames: vi.fn(),
    redact: (text: string) => text,
    log: (line: string) => { state.logs.push(line); return line; },
    stage: vi.fn(),
    getStage: () => "clone",
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(async (ctx) => {
    state.rebuild = ctx.rebuild;
    throw new Error("stop here");
  }),
  resolveCompose: vi.fn(),
  build: vi.fn(),
  swap: vi.fn(),
  postDeploy: vi.fn(),
}));
vi.mock("@/lib/docker/rollback-target", () => ({
  loadRollbackTarget: vi.fn(),
  applyRollbackTarget: vi.fn(),
  applyRollbackEnv: vi.fn(),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(true) }));

import { runDeployment } from "@/lib/docker/deploy";
import type { DeployOpts } from "@/lib/docker/deploy";

const PRODUCTION_ENV = { id: "env-prod", name: "production", type: "production", gitBranch: null, isDefault: true, domain: null };
const PREVIEW_ENV = { id: "env-pr-7", name: "pr-7", type: "preview", gitBranch: "feat/x", isDefault: false, domain: "notes-pr-7.example.com" };

// Manual and API cover the dashboard, REST and MCP; webhook, relay and poll are the git triggers.
const PATHS: { name: string; opts: Partial<DeployOpts>; env: Record<string, unknown> }[] = [
  { name: "manual", opts: { trigger: "manual" }, env: PRODUCTION_ENV },
  { name: "api and MCP", opts: { trigger: "api" }, env: PRODUCTION_ENV },
  { name: "webhook", opts: { trigger: "webhook" }, env: PRODUCTION_ENV },
  { name: "relay", opts: { trigger: "relay" }, env: PRODUCTION_ENV },
  { name: "poll", opts: { trigger: "poll" }, env: PRODUCTION_ENV },
  { name: "preview", opts: { trigger: "webhook", environmentId: "env-pr-7", groupEnvironmentId: "ge-1" }, env: PREVIEW_ENV },
];

async function deploy(opts: Partial<DeployOpts>, env: Record<string, unknown>) {
  state.envs.push(env, env);
  await runDeployment("dep-1", { appId: "app-1", organizationId: "org-1", trigger: "manual", ...opts } as DeployOpts);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.buildCache = "use";
  state.envs = [];
  state.rebuild = undefined;
  state.logs = [];
});

describe.each(PATHS)("Build cache setting on the $name path", ({ opts, env }) => {
  it("leaves the build alone on Use cache", async () => {
    await deploy(opts, env);
    expect(state.rebuild).toBeUndefined();
    expect(state.logs.some((l) => l.includes("Build cache:"))).toBe(false);
  });

  it("forces a rebuild on Skip image reuse and says so", async () => {
    state.buildCache = "skip-reuse";
    await deploy(opts, env);
    expect(state.rebuild).toBe("force");
    expect(state.logs).toContain("[deploy] Build cache: Skip image reuse: rebuilding with the layer cache (the app's Build cache setting)");
  });

  it("rebuilds without any cache on Never use cache and says so", async () => {
    state.buildCache = "never";
    await deploy(opts, env);
    expect(state.rebuild).toBe("no-cache");
    expect(state.logs).toContain("[deploy] Build cache: Never use cache: rebuilding without image reuse or the layer cache (the app's Build cache setting)");
  });

  it("lets a deploy that asks for a rebuild win", async () => {
    state.buildCache = "never";
    await deploy({ ...opts, rebuild: "force" }, env);
    expect(state.rebuild).toBe("force");
    expect(state.logs.some((l) => l.includes("this deploy asked for it"))).toBe(true);
  });
});
