import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// runDeployment — a non-default environment never reaches production state.
//
// A preview deploy routed every production hostname to its own containers, and
// its status writes landed on the production app row.
// ---------------------------------------------------------------------------

const { dbMock, statusWrites, captured, envRows, groupEnvHosts } = vi.hoisted(() => {
  const statusWrites: { table: unknown; values: Record<string, unknown> }[] = [];
  const captured: { domains?: { domain: string; port: number | null }[]; envName?: string } = {};
  const envRows: Record<string, unknown>[] = [];
  const groupEnvHosts: { domain: string | null }[] = [];

  const prodDomain = {
    id: "dom-prod-1",
    appId: "app-1",
    domain: "knowledge.example.com",
    serviceName: null,
    port: 3500,
    middlewares: null,
    certResolver: "le-dns",
    isPrimary: true,
    sslEnabled: true,
    redirectTo: null,
    redirectCode: 301,
    createdAt: new Date(0),
  };
  const legacyPreviewRow = { ...prodDomain, id: "dom-legacy", domain: "notes-api-pr-25.example.com", isPrimary: false };

  const dbMock = {
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        statusWrites.push({ table, values });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
    query: {
      apps: {
        findFirst: vi.fn(async () => ({
          id: "app-1",
          name: "notes-api",
          displayName: "Knowledge",
          organizationId: "org-1",
          projectId: null,
          source: "git",
          deployType: "compose",
          envContent: null,
          containerPort: null,
          domains: [{ ...prodDomain }, { ...legacyPreviewRow }],
        })),
      },
      domains: { findMany: vi.fn().mockResolvedValue([]) },
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: "org-1", name: "Org", baseDomain: "example.com", trusted: false }) },
      projects: { findFirst: vi.fn().mockResolvedValue(null) },
      environments: {
        findFirst: vi.fn(async () => envRows.shift() ?? null),
        findMany: vi.fn(async () => groupEnvHosts),
      },
      environmentEnv: { findFirst: vi.fn().mockResolvedValue(undefined) },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn().mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };

  return { dbMock, statusWrites, captured, envRows, groupEnvHosts };
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
    addSecrets: vi.fn(),
    redact: (text: string) => text,
    log: (line: string) => line,
    stage: vi.fn(),
    getStage: () => "clone",
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(async (ctx) => {
    captured.domains = ctx.app.domains.map((d: { domain: string; port: number | null }) => ({
      domain: d.domain,
      port: d.port,
    }));
    captured.envName = ctx.envName;
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
import { prepareRepo } from "@/lib/docker/deploy-steps";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { apps } from "@/lib/db/schema";

const PREVIEW_ENV = {
  id: "env-pr-25",
  name: "pr-25",
  type: "preview",
  gitBranch: "feat/x",
  isDefault: false,
  domain: "notes-api-pr-25.example.com",
};
const PRODUCTION_ENV = {
  id: "env-prod",
  name: "production",
  type: "production",
  gitBranch: null,
  isDefault: true,
  domain: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  statusWrites.length = 0;
  envRows.length = 0;
  groupEnvHosts.length = 0;
  delete captured.domains;
});

describe("runDeployment domains", () => {
  it("routes only the preview's own hostname for a preview deploy", async () => {
    envRows.push(PREVIEW_ENV);

    await runDeployment("dep-1", {
      appId: "app-1",
      organizationId: "org-1",
      trigger: "webhook",
      environmentId: "env-pr-25",
      groupEnvironmentId: "ge-1",
    });

    expect(captured.envName).toBe("pr-25");
    expect(captured.domains).toEqual([{ domain: "notes-api-pr-25.example.com", port: 3500 }]);
  });

  it("drops a preview hostname an older release stored on the production app", async () => {
    envRows.push(PRODUCTION_ENV, PRODUCTION_ENV);
    groupEnvHosts.push({ domain: "notes-api-pr-25.example.com" });

    await runDeployment("dep-2", { appId: "app-1", organizationId: "org-1", trigger: "manual" });

    expect(captured.domains).toEqual([{ domain: "knowledge.example.com", port: 3500 }]);
  });
});

describe("runDeployment app status", () => {
  const appStatusWrites = () =>
    statusWrites.filter((w) => w.table === apps && typeof w.values.status === "string").map((w) => w.values.status);

  it("leaves the production app's status alone when a preview deploy fails", async () => {
    envRows.push(PREVIEW_ENV);

    const result = await runDeployment("dep-3", {
      appId: "app-1",
      organizationId: "org-1",
      trigger: "webhook",
      environmentId: "env-pr-25",
      groupEnvironmentId: "ge-1",
    });

    expect(result.success).toBe(false);
    expect(appStatusWrites()).toEqual([]);
  });

  it("refuses a deploy for an environment that no longer exists", async () => {
    const result = await runDeployment("dep-4", {
      appId: "app-1",
      organizationId: "org-1",
      trigger: "webhook",
      environmentId: "env-deleted",
      groupEnvironmentId: "ge-1",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/does not exist/);
    expect(captured.domains).toBeUndefined();
    expect(appStatusWrites()).toEqual([]);
  });

  it("still owns the status for a production deploy", async () => {
    envRows.push(PRODUCTION_ENV, PRODUCTION_ENV);

    await runDeployment("dep-5", { appId: "app-1", organizationId: "org-1", trigger: "manual" });

    expect(appStatusWrites()).toEqual(["deploying", "error"]);
  });
});

describe("runDeployment with previews off", () => {
  it("refuses a preview deploy before touching the repo", async () => {
    vi.mocked(isFeatureEnabledAsync).mockResolvedValueOnce(false);
    envRows.push(PREVIEW_ENV);

    const result = await runDeployment("dep-6", {
      appId: "app-1",
      organizationId: "org-1",
      trigger: "webhook",
      environmentId: "env-pr-25",
      groupEnvironmentId: "ge-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Previews are disabled/);
    expect(prepareRepo).not.toHaveBeenCalled();
  });

  it("still deploys production", async () => {
    vi.mocked(isFeatureEnabledAsync).mockResolvedValue(false);
    envRows.push(PRODUCTION_ENV, PRODUCTION_ENV);

    await runDeployment("dep-7", { appId: "app-1", organizationId: "org-1", trigger: "manual" });

    expect(prepareRepo).toHaveBeenCalled();
    vi.mocked(isFeatureEnabledAsync).mockResolvedValue(true);
  });
});
