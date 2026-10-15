import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/infra/monitoring-network", () => ({ ensureMonitoringNetwork: vi.fn().mockResolvedValue(undefined) }));

// The collector core service exists unless VARDO_COLLECTOR_IMAGE=off or VARDO_COLLECTOR_URL is set.

const {
  dbMock,
  appsInserted,
  updateSets,
  settings,
  deployAndWaitMock,
  enqueueDeployMock,
  deleteAppMock,
  loadTemplatesMock,
} = vi.hoisted(() => {
  const appsInserted: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const settings = new Map<string, string>();

  const dbMock = {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        if (row && "deployType" in row) appsInserted.push(row);
        const thenable = { then: (res: (v: unknown) => void) => Promise.resolve([]).then(res) };
        return {
          ...thenable,
          onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "proj-1" }])) })),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
    query: { apps: { findFirst: vi.fn() } },
  };

  const template = (name: string, displayName: string) => ({
    name,
    displayName,
    description: name,
    source: "direct",
    deployType: "compose",
    composeContent: `services:\n  ${name}:\n    image: x\n`,
    defaultPort: 8080,
    defaultCpuLimit: null,
    defaultMemoryLimit: null,
    defaultDiskWriteAlertThreshold: null,
  });

  return {
    dbMock,
    appsInserted,
    updateSets,
    settings,
    deployAndWaitMock: vi.fn(),
    enqueueDeployMock: vi.fn(),
    deleteAppMock: vi.fn().mockResolvedValue({ deleted: true }),
    loadTemplatesMock: vi.fn(async () => [template("collector", "Collector")]),
  };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/config/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/features")>()),
  isFeatureEnabledAsync: vi.fn(async (flag: string) => flag === "metrics"),
}));
vi.mock("@/lib/templates/load", () => ({ loadTemplates: loadTemplatesMock }));
vi.mock("@/lib/deploy/request", () => ({ deployAndWait: deployAndWaitMock }));
vi.mock("@/lib/deploy/queue", () => ({ enqueueDeploy: enqueueDeployMock }));
vi.mock("@/lib/docker/delete-app", () => ({ deleteApp: deleteAppMock }));
vi.mock("@/lib/infra/vardo-org", () => ({ ensureVardoOrg: vi.fn(async () => ({ id: "vardo-org" })) }));
const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn(async () => ({ stdout: "{}" })) }));
vi.mock("@/lib/utils/exec", () => ({ execFileAsync }));
vi.mock("@/lib/crypto/encrypt", () => ({
  encrypt: (plain: string, org: string) => `enc[${org}]:${plain}`,
  decryptOrFallback: (value: string, org: string) => ({ content: value.replace(`enc[${org}]:`, ""), wasEncrypted: true }),
}));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSystemSetting: vi.fn(async (key: string, value: string) => void settings.set(key, value)),
  invalidateSettingsCache: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));

import { ensureInfraServices, provisionForFlag } from "@/lib/infra/provision";
import { DEFAULT_COLLECTOR_IMAGE } from "@/lib/collector/config";

const ENV_KEYS = ["VARDO_COLLECTOR_IMAGE", "VARDO_COLLECTOR_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function insertedNames() {
  return appsInserted.map((r) => r.name);
}

describe("collector provisioning", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    appsInserted.length = 0;
    updateSets.length = 0;
    settings.clear();
    dbMock.query.apps.findFirst.mockReset();
    dbMock.query.apps.findFirst.mockResolvedValue(null);
    deployAndWaitMock.mockReset();
    deployAndWaitMock.mockResolvedValue({ success: true });
    enqueueDeployMock.mockReset();
    enqueueDeployMock.mockResolvedValue({ id: "d1" });
    deleteAppMock.mockClear();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("isn't provisioned with VARDO_COLLECTOR_IMAGE=off", async () => {
    process.env.VARDO_COLLECTOR_IMAGE = "off";
    await ensureInfraServices();
    expect(insertedNames()).toEqual([]);
  });

  it("provisions the published image when VARDO_COLLECTOR_IMAGE is unset", async () => {
    await ensureInfraServices();
    expect(insertedNames()).toEqual(["collector"]);
    const collector = appsInserted.find((r) => r.name === "collector")!;
    expect(collector.envContent).toContain(`VARDO_COLLECTOR_IMAGE=${DEFAULT_COLLECTOR_IMAGE}\n`);
  });

  it("isn't provisioned when VARDO_COLLECTOR_URL points at an existing collector", async () => {
    process.env.VARDO_COLLECTOR_URL = "http://collector:9273";
    process.env.VARDO_COLLECTOR_IMAGE = "collector:3d51106";
    await ensureInfraServices();
    expect(insertedNames()).toEqual([]);
  });

  it("creates it with the image and a generated token in its env", async () => {
    process.env.VARDO_COLLECTOR_IMAGE = "collector:3d51106";
    await ensureInfraServices();

    expect(insertedNames()).toEqual(["collector"]);
    const token = settings.get("collector_token");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const collector = appsInserted.find((r) => r.name === "collector")!;
    expect(collector.envContent).toBe(`enc[vardo-org]:VARDO_COLLECTOR_IMAGE=collector:3d51106\nVARDO_COLLECTOR_TOKEN=${token}\n`);
    expect(collector.isSystemManaged).toBe(true);
  });

  it("keeps the token and redeploys when the image changes", async () => {
    process.env.VARDO_COLLECTOR_IMAGE = "collector:new";
    settings.set("collector_token", "kept");
    dbMock.query.apps.findFirst.mockImplementation(async () => ({
      id: "app-c",
      status: "active",
      organizationId: "vardo-org",
      isSystemManaged: true,
      composeContent: "services:\n  collector:\n    image: x\n",
      envContent: "enc[vardo-org]:VARDO_COLLECTOR_IMAGE=collector:old\nVARDO_COLLECTOR_TOKEN=kept\n",
    }));

    await ensureInfraServices();

    expect(updateSets).toContainEqual(
      expect.objectContaining({
        envContent: "enc[vardo-org]:VARDO_COLLECTOR_IMAGE=collector:new\nVARDO_COLLECTOR_TOKEN=kept\n",
        needsRedeploy: true,
      }),
    );
    expect(enqueueDeployMock).toHaveBeenCalledWith({ appId: "app-c", trigger: "api" });
  });

  it("gives it the host PID namespace and GPUs only on a GPU host", async () => {
    await ensureInfraServices();
    let collector = appsInserted.find((r) => r.name === "collector")!;
    expect(collector.composeContent).not.toContain("pid:");
    expect(collector.gpuEnabled).toBe(false);

    appsInserted.length = 0;
    execFileAsync.mockResolvedValue({ stdout: '{"nvidia":{"path":"nvidia-container-runtime"},"runc":{}}' });
    await ensureInfraServices();
    collector = appsInserted.find((r) => r.name === "collector")!;
    expect(collector.composeContent).toContain("  collector:\n    # GPU host");
    expect(collector.composeContent).toContain("    pid: host\n");
    expect(collector.gpuEnabled).toBe(true);
    execFileAsync.mockResolvedValue({ stdout: "{}" });
  });

  it("fails the metrics flag and rolls the collector back when its first deploy fails", async () => {
    process.env.VARDO_COLLECTOR_IMAGE = "collector:missing";
    deployAndWaitMock.mockResolvedValue({ success: false });

    await expect(provisionForFlag("metrics", true)).rejects.toThrow("Collector failed to deploy.");
    expect(deleteAppMock).toHaveBeenCalledTimes(1);
  });
});
