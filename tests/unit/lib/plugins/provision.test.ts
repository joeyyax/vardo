import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceRequirement } from "@/lib/plugins/manifest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { dbMock } = vi.hoisted(() => {
  const findFirstApps = vi.fn().mockResolvedValue(null);
  const findFirstOrgs = vi.fn().mockResolvedValue(null);

  // Chainable insert: .insert(table).values(data).returning(cols)
  const insertReturningFn = vi.fn().mockResolvedValue([{ id: "test-id-123" }]);
  const onConflictDoUpdateFn = vi.fn(() => ({
    returning: insertReturningFn,
  }));
  const insertValuesFn = vi.fn(() => ({
    returning: insertReturningFn,
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    onConflictDoUpdate: onConflictDoUpdateFn,
    then: (resolve: (v: unknown) => void) => resolve(undefined),
  }));
  const insertFn = vi.fn(() => ({ values: insertValuesFn }));

  // Chainable delete: .delete(table).where(condition)
  const deleteWhereFn = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn(() => ({ where: deleteWhereFn }));

  const dbMock = {
    query: {
      apps: { findFirst: findFirstApps },
      organizations: { findFirst: findFirstOrgs },
    },
    insert: insertFn,
    delete: deleteFn,
    _insertValues: insertValuesFn,
    _insertReturning: insertReturningFn,
    _deleteWhere: deleteWhereFn,
  };

  return { dbMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));

vi.mock("@/lib/db/schema", () => ({
  apps: { id: "apps.id", organizationId: "apps.organizationId" },
  environments: { id: "environments.id" },
  volumes: { id: "volumes.id" },
  domains: { id: "domains.id" },
  organizations: { id: "organizations.id" },
  projects: { id: "projects.id", organizationId: "projects.organizationId", name: "projects.name" },
  pluginSettings: {
    id: "pluginSettings.id",
    pluginId: "pluginSettings.pluginId",
    organizationId: "pluginSettings.organizationId",
    key: "pluginSettings.key",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNull: (col: string) => ({ op: "isNull", col }),
}));

const mockLoadTemplates = vi.fn();
vi.mock("@/lib/templates/load", () => ({
  loadTemplates: mockLoadTemplates,
}));

const mockGenerateSubdomain = vi.fn();
vi.mock("@/lib/domains/auto-domain", () => ({
  generateSubdomain: mockGenerateSubdomain,
}));

const mockGetSslConfig = vi.fn();
const mockGetPrimaryIssuer = vi.fn();
vi.mock("@/lib/system-settings", () => ({
  getSslConfig: mockGetSslConfig,
  getPrimaryIssuer: mockGetPrimaryIssuer,
}));

const mockRequestDeploy = vi.fn();
vi.mock("@/lib/docker/deploy-cancel", () => ({
  requestDeploy: mockRequestDeploy,
}));

const mockStopProject = vi.fn();
vi.mock("@/lib/docker/deploy", () => ({
  stopProject: mockStopProject,
}));

const mockGetPluginSetting = vi.fn();
const mockSetPluginSetting = vi.fn();
const mockDeletePluginSetting = vi.fn();
vi.mock("@/lib/plugins/registry", () => ({
  getPluginSetting: mockGetPluginSetting,
  setPluginSetting: mockSetPluginSetting,
  deletePluginSetting: mockDeletePluginSetting,
}));

vi.mock("nanoid", () => ({
  nanoid: () => "test-id-123",
}));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockTemplate = {
  name: "cadvisor",
  displayName: "cAdvisor",
  description: "Container metrics",
  source: "direct",
  deployType: "compose",
  imageName: null,
  composeContent:
    "services:\n  cadvisor:\n    image: gcr.io/cadvisor/cadvisor:latest",
  defaultPort: 8080,
  defaultVolumes: [{ name: "data", mountPath: "/data", description: "Data" }],
  defaultCpuLimit: null,
  defaultMemoryLimit: null,
  defaultDiskWriteAlertThreshold: null,
  defaultConnectionInfo: null,
};

const mockService: ServiceRequirement = {
  name: "cadvisor",
  check: "http",
  default: "http://cadvisor:8080",
  setting: "cadvisorUrl",
  provisionable: true,
  templateName: "cadvisor",
};

const ORG_ID = "org-123";
const PLUGIN_ID = "metrics-plugin";

function setupHappyPath() {
  mockGetPluginSetting.mockResolvedValue(null);
  mockLoadTemplates.mockResolvedValue([mockTemplate]);
  dbMock.query.organizations.findFirst.mockResolvedValue({
    id: ORG_ID,
    baseDomain: "example.com",
  });
  mockGenerateSubdomain.mockReturnValue("cadvisor.example.com");
  mockGetSslConfig.mockResolvedValue({ issuer: "letsencrypt" });
  mockGetPrimaryIssuer.mockReturnValue("letsencrypt");
  mockRequestDeploy.mockResolvedValue(undefined);
  mockSetPluginSetting.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provisionService", () => {
  let provisionService: typeof import("@/lib/plugins/provision").provisionService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    dbMock.query.apps.findFirst.mockResolvedValue(null);
    dbMock.query.organizations.findFirst.mockResolvedValue(null);

    const mod = await import("@/lib/plugins/provision");
    provisionService = mod.provisionService;
  });

  it("creates app with env/volumes/domain and returns appId on happy path", async () => {
    setupHappyPath();

    const result = await provisionService(PLUGIN_ID, mockService, ORG_ID);

    expect(result).toEqual({ appId: "test-id-123" });

    // Should insert: app, environment, volume, domain (4 inserts)
    expect(dbMock.insert).toHaveBeenCalledTimes(5);

    // Should store the provisioned app reference
    expect(mockSetPluginSetting).toHaveBeenCalledWith(
      PLUGIN_ID,
      "provisionedAppId:cadvisor",
      "test-id-123",
      ORG_ID,
    );

    // Should kick off a deploy
    expect(mockRequestDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "test-id-123",
        organizationId: ORG_ID,
        trigger: "manual",
        triggeredBy: "system",
      }),
    );
  });

  it("returns existing appId without creating anything when already provisioned", async () => {
    mockGetPluginSetting.mockResolvedValue("existing-app-id");
    dbMock.query.apps.findFirst.mockResolvedValue({ id: "existing-app-id" });

    const result = await provisionService(PLUGIN_ID, mockService, ORG_ID);

    expect(result).toEqual({ appId: "existing-app-id" });
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(mockRequestDeploy).not.toHaveBeenCalled();
  });

  it("re-provisions when plugin setting references a stale (deleted) app", async () => {
    // getPluginSetting returns an app ID, but the app no longer exists
    mockGetPluginSetting
      .mockResolvedValueOnce("stale-app-id") // first call: check existing
      .mockResolvedValue(null); // subsequent calls
    dbMock.query.apps.findFirst.mockResolvedValue(null); // app doesn't exist

    mockLoadTemplates.mockResolvedValue([mockTemplate]);
    dbMock.query.organizations.findFirst.mockResolvedValue({
      id: ORG_ID,
      baseDomain: "example.com",
    });
    mockGenerateSubdomain.mockReturnValue("cadvisor.example.com");
    mockGetSslConfig.mockResolvedValue({ issuer: "letsencrypt" });
    mockGetPrimaryIssuer.mockReturnValue("letsencrypt");
    mockRequestDeploy.mockResolvedValue(undefined);
    mockSetPluginSetting.mockResolvedValue(undefined);

    const result = await provisionService(PLUGIN_ID, mockService, ORG_ID);

    expect(result).toEqual({ appId: "test-id-123" });
    // Should have created a new app
    expect(dbMock.insert).toHaveBeenCalled();
    expect(mockSetPluginSetting).toHaveBeenCalledWith(
      PLUGIN_ID,
      "provisionedAppId:cadvisor",
      "test-id-123",
      ORG_ID,
    );
  });

  it("throws when template is not found", async () => {
    mockGetPluginSetting.mockResolvedValue(null);
    mockLoadTemplates.mockResolvedValue([]);

    await expect(
      provisionService(PLUGIN_ID, mockService, ORG_ID),
    ).rejects.toThrow('No template "cadvisor" found for service cadvisor');
  });

  it("throws when organization is not found", async () => {
    mockGetPluginSetting.mockResolvedValue(null);
    mockLoadTemplates.mockResolvedValue([mockTemplate]);
    dbMock.query.organizations.findFirst.mockResolvedValue(null);

    await expect(
      provisionService(PLUGIN_ID, mockService, ORG_ID),
    ).rejects.toThrow("Organization not found");
  });

  it("returns appId even when deploy fails (fire-and-forget)", async () => {
    setupHappyPath();
    mockRequestDeploy.mockRejectedValue(new Error("deploy exploded"));

    const result = await provisionService(PLUGIN_ID, mockService, ORG_ID);

    expect(result).toEqual({ appId: "test-id-123" });
  });

  it("uses service.name as templateName when templateName is not set", async () => {
    const serviceWithoutTemplateName: ServiceRequirement = {
      ...mockService,
      templateName: undefined,
    };

    setupHappyPath();

    await provisionService(PLUGIN_ID, serviceWithoutTemplateName, ORG_ID);

    // loadTemplates was called, and template lookup used service.name ("cadvisor")
    expect(dbMock.insert).toHaveBeenCalled();
  });

  it("skips domain creation when generateSubdomain returns null", async () => {
    setupHappyPath();
    mockGenerateSubdomain.mockReturnValue(null);

    await provisionService(PLUGIN_ID, mockService, ORG_ID);

    // Should insert: project, app, environment, volume (4 inserts — no domain)
    expect(dbMock.insert).toHaveBeenCalledTimes(4);
  });
});

describe("deprovisionService", () => {
  let deprovisionService: typeof import("@/lib/plugins/provision").deprovisionService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    dbMock.query.apps.findFirst.mockResolvedValue(null);
    dbMock.query.organizations.findFirst.mockResolvedValue(null);
    mockDeletePluginSetting.mockResolvedValue(undefined);

    const mod = await import("@/lib/plugins/provision");
    deprovisionService = mod.deprovisionService;
  });

  it("stops project, deletes app, and clears setting on happy path", async () => {
    mockGetPluginSetting.mockResolvedValue("app-to-remove");
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "app-to-remove",
      name: "cadvisor",
    });
    mockStopProject.mockResolvedValue(undefined);

    await deprovisionService(PLUGIN_ID, "cadvisor", ORG_ID);

    expect(mockStopProject).toHaveBeenCalledWith(
      "app-to-remove",
      "cadvisor",
      undefined,
      true,
    );

    expect(dbMock.delete).toHaveBeenCalled();
    expect(dbMock._deleteWhere).toHaveBeenCalled();

    expect(mockDeletePluginSetting).toHaveBeenCalledWith(
      PLUGIN_ID,
      "provisionedAppId:cadvisor",
      ORG_ID,
    );
  });

  it("no-ops when no provisioned app exists", async () => {
    mockGetPluginSetting.mockResolvedValue(null);

    await deprovisionService(PLUGIN_ID, "cadvisor", ORG_ID);

    expect(mockStopProject).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();
    expect(mockDeletePluginSetting).not.toHaveBeenCalled();
  });

  it("cleans up stale setting when app no longer exists in DB", async () => {
    mockGetPluginSetting.mockResolvedValue("ghost-app-id");
    dbMock.query.apps.findFirst.mockResolvedValue(null);

    await deprovisionService(PLUGIN_ID, "cadvisor", ORG_ID);

    // Should not try to stop or delete an app that doesn't exist
    expect(mockStopProject).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();

    // But should still clean up the stale setting
    expect(mockDeletePluginSetting).toHaveBeenCalledWith(
      PLUGIN_ID,
      "provisionedAppId:cadvisor",
      ORG_ID,
    );
  });

  it("still deletes app and setting when stopProject throws", async () => {
    mockGetPluginSetting.mockResolvedValue("app-to-remove");
    dbMock.query.apps.findFirst.mockResolvedValue({
      id: "app-to-remove",
      name: "cadvisor",
    });
    mockStopProject.mockRejectedValue(new Error("container not found"));

    await deprovisionService(PLUGIN_ID, "cadvisor", ORG_ID);

    // Stop was attempted
    expect(mockStopProject).toHaveBeenCalled();

    // App was still deleted despite stop failure
    expect(dbMock.delete).toHaveBeenCalled();

    // Setting was still cleaned up
    expect(mockDeletePluginSetting).toHaveBeenCalledWith(
      PLUGIN_ID,
      "provisionedAppId:cadvisor",
      ORG_ID,
    );
  });
});
