import { describe, it, expect, beforeEach, vi } from "vitest";

// A core service's compose is copied onto the app row at creation, so a
// template fix reaches new installs only unless provisioning re-syncs it.

const { dbMock, requestDeployMock, loadTemplatesMock, ensureVardoOrgMock, setSystemSettingMock, updateSets } =
  vi.hoisted(() => {
    const updateSets: Record<string, unknown>[] = [];

    const dbMock = {
      insert: vi.fn(),
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
      updateSets,
      requestDeployMock: vi.fn(),
      loadTemplatesMock: vi.fn(async () => [
        {
          name: "loki",
          displayName: "Loki",
          description: "Loki",
          source: "direct",
          deployType: "compose",
          composeContent: "services:\n  loki:\n    image: grafana/loki:3.4\n",
          defaultPort: 3100,
          defaultCpuLimit: null,
          defaultMemoryLimit: null,
          defaultDiskWriteAlertThreshold: null,
        },
      ]),
      ensureVardoOrgMock: vi.fn(async () => ({ id: "org-1" })),
      setSystemSettingMock: vi.fn().mockResolvedValue(undefined),
    };
  });

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/config/features", () => ({
  isFeatureEnabledAsync: vi.fn(async (flag: string) => flag === "logging"),
}));
vi.mock("@/lib/templates/load", () => ({ loadTemplates: loadTemplatesMock }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy: requestDeployMock }));
vi.mock("@/lib/docker/delete-app", () => ({ deleteApp: vi.fn() }));
vi.mock("@/lib/infra/vardo-org", () => ({ ensureVardoOrg: ensureVardoOrgMock }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn().mockResolvedValue(null),
  setSystemSetting: setSystemSettingMock,
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { ensureInfraServices } from "@/lib/infra/provision";

const CURRENT = "services:\n  loki:\n    image: grafana/loki:3.4\n";

function existingApp(composeContent: string | null) {
  return {
    id: "app-1",
    status: "active",
    organizationId: "org-1",
    isSystemManaged: true,
    composeContent,
  };
}

describe("ensureInfraServices — template re-sync", () => {
  beforeEach(() => {
    updateSets.length = 0;
    requestDeployMock.mockReset();
    requestDeployMock.mockResolvedValue({ deploymentId: "d1", success: true, log: "", durationMs: 1 });
  });

  it("rewrites a stale compose and redeploys", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(existingApp("services:\n  loki:\n    image: grafana/loki:2.9\n"));

    await ensureInfraServices();

    expect(updateSets).toContainEqual(
      expect.objectContaining({ composeContent: CURRENT, needsRedeploy: true }),
    );
    expect(requestDeployMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-1", organizationId: "org-1" }),
    );
  });

  it("leaves a current compose alone and does not redeploy", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(existingApp(CURRENT));

    await ensureInfraServices();

    expect(updateSets).toHaveLength(0);
    expect(requestDeployMock).not.toHaveBeenCalled();
  });
});
