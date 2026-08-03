import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Issue #79: the cAdvisor disk metrics setting must reach the compose content
// that provisioning writes to the app row — at boot reconcile, not just via
// the admin toggle route — so a fresh install or a stale-compose redeploy
// both come up with the setting already applied.

const { dbMock, requestDeployMock, loadTemplatesMock, ensureVardoOrgMock, getSystemSettingRawMock, insertedRows, updateSets } =
  vi.hoisted(() => {
    const insertedRows: Record<string, unknown>[] = [];
    const updateSets: Record<string, unknown>[] = [];

    // Only the app row carries deployType — ensureProject's insert doesn't —
    // so that's how the two calls are told apart here.
    const insertFn = vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        if (row && "deployType" in row) insertedRows.push(row);
        const thenable = { then: (res: (v: unknown) => void) => Promise.resolve([]).then(res) };
        return {
          ...thenable,
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: "proj-1" }])),
          })),
        };
      }),
    }));

    const dbMock = {
      insert: insertFn,
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updateSets.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
      query: { apps: { findFirst: vi.fn() } },
    };

    return {
      dbMock,
      insertedRows,
      updateSets,
      requestDeployMock: vi.fn(),
      loadTemplatesMock: vi.fn(),
      ensureVardoOrgMock: vi.fn(async () => ({ id: "org-1" })),
      getSystemSettingRawMock: vi.fn(),
    };
  });

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/config/features", () => ({
  isFeatureEnabledAsync: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/templates/load", () => ({ loadTemplates: loadTemplatesMock }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy: requestDeployMock }));
vi.mock("@/lib/docker/delete-app", () => ({ deleteApp: vi.fn() }));
vi.mock("@/lib/infra/vardo-org", () => ({ ensureVardoOrg: ensureVardoOrgMock }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: getSystemSettingRawMock,
  setSystemSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));

import { ensureInfraServices } from "@/lib/infra/provision";

// Loaded through the real (unmocked) template pipeline so the fixture matches
// exactly what YAML.parse hands provision.ts in production — not a hand-typed
// copy that could drift from the file's actual indentation.
let TEMPLATE_COMPOSE: string;

beforeAll(async () => {
  const real = await vi.importActual<typeof import("@/lib/templates/load")>("@/lib/templates/load");
  const templates = await real.loadTemplates();
  const cadvisor = templates.find((t) => t.name === "cadvisor");
  if (!cadvisor?.composeContent) throw new Error("cadvisor template not found");
  TEMPLATE_COMPOSE = cadvisor.composeContent;
});

beforeEach(() => {
  insertedRows.length = 0;
  updateSets.length = 0;
  requestDeployMock.mockReset();
  requestDeployMock.mockResolvedValue({ deploymentId: "d1", success: true, log: "", durationMs: 1 });
  loadTemplatesMock.mockReset();
  loadTemplatesMock.mockImplementation(async () => [
    {
      name: "cadvisor",
      displayName: "cAdvisor",
      description: "cAdvisor",
      source: "direct",
      deployType: "compose",
      composeContent: TEMPLATE_COMPOSE,
      defaultPort: 8080,
      defaultCpuLimit: null,
      defaultMemoryLimit: null,
      defaultDiskWriteAlertThreshold: null,
    },
  ]);
});

describe("ensureInfraServices — cAdvisor disk metrics setting", () => {
  it("installs with disk metrics on by default", async () => {
    getSystemSettingRawMock.mockResolvedValue(null);
    dbMock.query.apps.findFirst.mockResolvedValue(null);

    await ensureInfraServices();

    expect(insertedRows[0].composeContent).toBe(TEMPLATE_COMPOSE);
    expect(insertedRows[0].composeContent).toContain("--disable_metrics=udp,percpu\n");
    expect(insertedRows[0].composeContent).toContain("mem_limit: 512m");
  });

  it("installs with disk metrics off when the setting is disabled", async () => {
    getSystemSettingRawMock.mockResolvedValue(JSON.stringify({ diskMetricsEnabled: false }));
    dbMock.query.apps.findFirst.mockResolvedValue(null);

    await ensureInfraServices();

    const composeContent = insertedRows[0].composeContent as string;
    expect(composeContent).toContain("--disable_metrics=udp,percpu,disk,diskIO");
    expect(composeContent).toContain("mem_limit: 256m");
    expect(composeContent).not.toContain("mem_limit: 512m");
  });

  it("redeploys an existing install once the setting flips off", async () => {
    getSystemSettingRawMock.mockResolvedValue(JSON.stringify({ diskMetricsEnabled: false }));
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "app-1",
      status: "active",
      organizationId: "org-1",
      isSystemManaged: true,
      composeContent: TEMPLATE_COMPOSE, // stored compose still reflects the old "on" state
    });

    await ensureInfraServices();

    expect(updateSets).toContainEqual(expect.objectContaining({ needsRedeploy: true }));
    const staleUpdate = updateSets.find((u) => "composeContent" in u);
    expect(staleUpdate?.composeContent).toContain("mem_limit: 256m");
    expect(requestDeployMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-1", organizationId: "org-1" }),
    );
  });
});
