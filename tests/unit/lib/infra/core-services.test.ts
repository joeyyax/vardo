import { describe, it, expect, beforeEach, vi } from "vitest";

// cAdvisor, Loki, Promtail and GlitchTip are instance-level singletons. The
// lookup is by app name across the whole instance, so an existing row is
// adopted wherever it lives — never duplicated, never silently skipped.

const {
  dbMock,
  requestDeployMock,
  deleteAppMock,
  loadTemplatesMock,
  ensureVardoOrgMock,
  setSystemSettingMock,
  getSystemSettingRawMock,
  appsInserted,
} = vi.hoisted(() => {
  const appsInserted: Record<string, unknown>[] = [];

  // Only app rows carry deployType, which is how they're told apart here.
  const insertFn = vi.fn(() => ({
    values: vi.fn((row: Record<string, unknown>) => {
      if (row && "deployType" in row) appsInserted.push(row);
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
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    query: {
      apps: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  };

  const template = (name: string, displayName: string) => ({
    name,
    displayName,
    description: name,
    source: "direct",
    deployType: "compose",
    composeContent: "services: {}",
    defaultPort: 8080,
    defaultCpuLimit: null,
    defaultMemoryLimit: null,
    defaultDiskWriteAlertThreshold: null,
  });

  return {
    dbMock,
    appsInserted,
    requestDeployMock: vi.fn(),
    deleteAppMock: vi.fn().mockResolvedValue({ deleted: true }),
    loadTemplatesMock: vi.fn(async () => [
      template("glitchtip", "GlitchTip"),
      template("loki", "Loki"),
      template("promtail", "Promtail"),
      template("cadvisor", "cAdvisor"),
    ]),
    ensureVardoOrgMock: vi.fn(async () => ({ id: "vardo-org" })),
    setSystemSettingMock: vi.fn().mockResolvedValue(undefined),
    getSystemSettingRawMock: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/config/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/features")>()),
  isFeatureEnabledAsync: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/templates/load", () => ({ loadTemplates: loadTemplatesMock }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy: requestDeployMock }));
vi.mock("@/lib/docker/delete-app", () => ({ deleteApp: deleteAppMock }));
vi.mock("@/lib/infra/vardo-org", () => ({ ensureVardoOrg: ensureVardoOrgMock }));
vi.mock("@/lib/system-settings", () => ({
  setSystemSetting: setSystemSettingMock,
  getSystemSettingRaw: getSystemSettingRawMock,
  invalidateSettingsCache: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));

import { ensureInfraServices, provisionForFlag } from "@/lib/infra/provision";
import {
  CORE_SERVICE_FLAGS,
  CORE_SERVICE_NAMES,
  isCoreServiceApp,
  summarizeCoreServices,
} from "@/lib/infra/core-services";
import { SHARED_SERVICE_FLAGS } from "@/lib/config/features";

/** Last status record handed to setSystemSetting, keyed by service name. */
function lastRecordedStatus() {
  const call = setSystemSettingMock.mock.calls.at(-1);
  return call ? JSON.parse(call[1] as string) : {};
}

describe("core service provisioning", () => {
  beforeEach(() => {
    requestDeployMock.mockReset();
    requestDeployMock.mockResolvedValue({ deploymentId: "d1", success: true, log: "", durationMs: 1 });
    deleteAppMock.mockClear();
    dbMock.insert.mockClear();
    dbMock.query.apps.findFirst.mockResolvedValue(null);
    setSystemSettingMock.mockClear();
    getSystemSettingRawMock.mockResolvedValue(null);
    appsInserted.length = 0;
  });

  it("creates the row in the Vardo system org on a clean instance", async () => {
    await provisionForFlag("error-tracking", true);

    expect(appsInserted).toHaveLength(1);
    expect(appsInserted[0]).toMatchObject({
      name: "glitchtip",
      organizationId: "vardo-org",
      isSystemManaged: true,
    });
  });

  it("adopts a row that already exists rather than creating a second one", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "app-1",
      status: "running",
      organizationId: "vardo-org",
      isSystemManaged: true,
      composeContent: "services: {}",
    });

    await provisionForFlag("error-tracking", true);

    expect(appsInserted).toHaveLength(0);
    expect(requestDeployMock).not.toHaveBeenCalled();
    expect(lastRecordedStatus().glitchtip).toMatchObject({ state: "provisioned", appId: "app-1" });
  });

  it("does not duplicate or move a row that landed in another organization", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "app-1",
      status: "running",
      organizationId: "some-other-org",
      isSystemManaged: true,
      composeContent: "services: {}",
    });

    await provisionForFlag("error-tracking", true);

    expect(appsInserted).toHaveLength(0);
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(lastRecordedStatus().glitchtip).toMatchObject({
      state: "provisioned",
      organizationId: "some-other-org",
    });
  });

  it("reports a name conflict instead of silently skipping", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "user-app",
      status: "running",
      organizationId: "tenant-org",
      isSystemManaged: false,
    });

    await expect(provisionForFlag("error-tracking", true)).rejects.toThrow(
      /already exists on this instance/i,
    );
    expect(appsInserted).toHaveLength(0);
    expect(lastRecordedStatus().glitchtip).toMatchObject({ state: "conflict" });
  });

  it("redeploys an adopted row whose container went missing, in its own org", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "app-1",
      status: "missing",
      organizationId: "some-other-org",
      isSystemManaged: true,
      composeContent: "services: {}",
    });

    await provisionForFlag("error-tracking", true);

    expect(requestDeployMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-1", organizationId: "some-other-org" }),
    );
  });

  it("startup provisioning over existing rows writes no rows and records every service", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "app-1",
      status: "running",
      organizationId: "vardo-org",
      isSystemManaged: true,
      composeContent: "services: {}",
    });

    await ensureInfraServices();

    expect(appsInserted).toHaveLength(0);
    const status = lastRecordedStatus();
    expect(Object.keys(status).sort()).toEqual([...CORE_SERVICE_NAMES].sort());
    for (const name of CORE_SERVICE_NAMES) expect(status[name].state).toBe("provisioned");
  });

  it("records a missing template rather than skipping it quietly", async () => {
    loadTemplatesMock.mockResolvedValueOnce([]);

    await expect(provisionForFlag("error-tracking", true)).rejects.toThrow(/template/i);
    expect(lastRecordedStatus().glitchtip).toMatchObject({ state: "missing-template" });
  });
});

describe("core service metadata", () => {
  it("names every instance-level service", () => {
    expect(CORE_SERVICE_NAMES).toEqual(["cadvisor", "loki", "promtail", "glitchtip"]);
    expect(isCoreServiceApp("cadvisor")).toBe(true);
    expect(isCoreServiceApp("wordpress")).toBe(false);
  });

  it("agrees with the flags marked as shared services", () => {
    expect([...CORE_SERVICE_FLAGS].sort()).toEqual([...SHARED_SERVICE_FLAGS].sort());
  });

  it("reports a disabled flag as off and an enabled-but-unprovisioned service as failed", () => {
    const summary = summarizeCoreServices(
      {},
      { metrics: false, logging: true, "error-tracking": false },
    );
    const byName = Object.fromEntries(summary.map((s) => [s.name, s]));

    expect(byName.cadvisor.state).toBe("off");
    expect(byName.cadvisor.detail).toBeNull();
    expect(byName.loki.state).toBe("failed");
    expect(byName.loki.detail).toMatch(/never provisioned/i);
  });
});
