import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

// A non-default environment deploys with its own env. The default environment
// reads apps.env_content exactly as before.

const { dbMock, captured, envRows, envSnapshots, appEnv } = vi.hoisted(() => {
  const captured: { envMap?: Record<string, string>; appEnvContent?: string | null } = {};
  const envRows: Record<string, unknown>[] = [];
  const envSnapshots: Record<string, string> = {};
  const appEnv: { content: string | null } = { content: null };

  const dbMock = {
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
    query: {
      apps: {
        findFirst: vi.fn(async () => ({
          id: "app-1",
          name: "web",
          displayName: "Web",
          organizationId: "org-1",
          projectId: null,
          source: "git",
          deployType: "compose",
          envContent: appEnv.content,
          containerPort: null,
          domains: [
            {
              id: "dom-1",
              appId: "app-1",
              domain: "web.example.com",
              serviceName: null,
              port: 3000,
              isPrimary: true,
              sslEnabled: true,
              redirectTo: null,
              redirectCode: 301,
            },
          ],
        })),
      },
      domains: { findMany: vi.fn().mockResolvedValue([]) },
      organizations: { findFirst: vi.fn().mockResolvedValue({ id: "org-1", name: "Org", baseDomain: "example.com", trusted: false }) },
      projects: { findFirst: vi.fn().mockResolvedValue(null) },
      environments: {
        findFirst: vi.fn(async () => envRows.shift() ?? null),
        findMany: vi.fn(async () => []),
      },
      environmentEnv: {
        findFirst: vi.fn(async () => {
          const content = envSnapshots["env-pr-7"];
          return content ? { environmentId: "env-pr-7", envContent: content } : undefined;
        }),
      },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn().mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };

  return { dbMock, captured, envRows, envSnapshots, appEnv };
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
    log: (line: string) => line,
    stage: vi.fn(),
    getStage: () => "clone",
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(async (ctx) => {
    captured.envMap = { ...ctx.envMap };
    captured.appEnvContent = ctx.app.envContent;
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
import { encrypt } from "@/lib/crypto/encrypt";

const PROD_ENV_TEXT = "# production\nDATABASE_URL=postgres://app:prod-pass@db.example.com:5432/app\nAPI_SECRET=prod-secret\n";
const PREVIEW_ENV_TEXT = "DATABASE_URL=postgres://app:pr-pass@db-pr-7.example.com:5432/app\nAPI_SECRET=\n";

const PREVIEW_ENV = {
  id: "env-pr-7",
  name: "pr-7",
  type: "preview",
  gitBranch: "feat/x",
  isDefault: false,
  domain: "web-pr-7.example.com",
};
const STAGING_ENV = { ...PREVIEW_ENV, name: "staging", type: "staging" };
const PRODUCTION_ENV = {
  id: "env-prod",
  name: "production",
  type: "production",
  gitBranch: null,
  isDefault: true,
  domain: null,
};

async function deploy(opts: { environmentId?: string; groupEnvironmentId?: string }) {
  const lines: string[] = [];
  await runDeployment("dep-1", {
    appId: "app-1",
    organizationId: "org-1",
    trigger: "webhook",
    onLog: (l) => lines.push(l),
    ...opts,
  });
  return lines;
}

beforeEach(() => {
  vi.clearAllMocks();
  envRows.length = 0;
  for (const k of Object.keys(envSnapshots)) delete envSnapshots[k];
  delete captured.envMap;
  appEnv.content = encrypt(PROD_ENV_TEXT, "org-1");
});

describe("runDeployment environment env", () => {
  it("deploys a preview with its own env, not apps.envContent", async () => {
    envRows.push(PREVIEW_ENV);
    envSnapshots["env-pr-7"] = encrypt(PREVIEW_ENV_TEXT, "org-1");

    const lines = await deploy({ environmentId: "env-pr-7", groupEnvironmentId: "ge-1" });

    expect(captured.envMap).toEqual({
      DATABASE_URL: "postgres://app:pr-pass@db-pr-7.example.com:5432/app",
      API_SECRET: "",
    });
    expect(lines.join("\n")).not.toMatch(/points at production/);
  });

  it("falls back to the app env with a warning when a staging environment predates snapshots", async () => {
    envRows.push(STAGING_ENV);

    const lines = await deploy({ environmentId: "env-pr-7", groupEnvironmentId: "ge-1" });

    expect(captured.envMap?.DATABASE_URL).toBe("postgres://app:prod-pass@db.example.com:5432/app");
    expect(lines.join("\n")).toMatch(/Warning: environment staging has no env of its own — deploying with the app's env/);
  });

  it("refuses a preview with no env of its own rather than deploy production's", async () => {
    envRows.push(PREVIEW_ENV);

    const lines = await deploy({ environmentId: "env-pr-7", groupEnvironmentId: "ge-1" });

    expect(captured.envMap).toBeUndefined();
    expect(lines.join("\n")).toMatch(/Preview pr-7 has no env of its own/);
  });

  it("warns when a preview's env still names a production hostname", async () => {
    envRows.push(PREVIEW_ENV);
    envSnapshots["env-pr-7"] = encrypt("PUBLIC_URL=https://web.example.com\n", "org-1");

    const lines = await deploy({ environmentId: "env-pr-7", groupEnvironmentId: "ge-1" });

    expect(lines.join("\n")).toMatch(/Warning: PUBLIC_URL points at production's web\.yax\.me/);
  });

  it("deploys production from apps.envContent unchanged", async () => {
    envRows.push(PRODUCTION_ENV, PRODUCTION_ENV);
    const stored = appEnv.content;

    await deploy({});

    expect(captured.appEnvContent).toBe(stored);
    expect(captured.envMap).toEqual({
      DATABASE_URL: "postgres://app:prod-pass@db.example.com:5432/app",
      API_SECRET: "prod-secret",
    });
    expect(dbMock.query.environmentEnv.findFirst).not.toHaveBeenCalled();
  });
});
