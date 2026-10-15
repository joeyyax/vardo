import { describe, it, expect, vi, beforeEach } from "vitest";

const { settings, findApp, deleteAppMock, resolveIncident, recordStatus, removeStatus, lock } = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  findApp: vi.fn(),
  deleteAppMock: vi.fn(),
  resolveIncident: vi.fn(),
  recordStatus: vi.fn(),
  removeStatus: vi.fn(),
  lock: { held: false },
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: findApp },
      organizations: { findMany: vi.fn(async () => [{ id: "org-a" }, { id: "vardo-org" }]) },
    },
  },
}));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSystemSetting: vi.fn(async (key: string, value: string) => void settings.set(key, value)),
}));
vi.mock("@/lib/docker/delete-app", () => ({ deleteApp: deleteAppMock }));
vi.mock("@/lib/incidents/system", () => ({ resolveSystemIncident: resolveIncident }));
vi.mock("@/lib/infra/core-services", () => ({ recordCoreServiceStatus: recordStatus, removeCoreServiceStatus: removeStatus }));
vi.mock("@/lib/redis-lock", () => ({
  acquireLock: vi.fn(async () => (lock.held ? null : "token")),
  releaseLock: vi.fn(async () => true),
}));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

import { FIRST_SERVED_KEY, markCollectorServed, retireCadvisor } from "@/lib/infra/retire-cadvisor";

const CADVISOR = { id: "app-cad", organizationId: "vardo-org", isSystemManaged: true };
const provisioned = { env: {}, readCollector: vi.fn(async () => []) };

describe("retireCadvisor", () => {
  beforeEach(() => {
    settings.clear();
    lock.held = false;
    vi.clearAllMocks();
    findApp.mockResolvedValue(CADVISOR);
    deleteAppMock.mockResolvedValue({ deleted: true });
    provisioned.readCollector.mockResolvedValue([]);
  });

  it("keeps cAdvisor until the collector has served, and says why", async () => {
    const result = await retireCadvisor(provisioned);

    expect(result.state).toBe("waiting");
    expect(deleteAppMock).not.toHaveBeenCalled();
    expect(settings.has("cadvisor_retired")).toBe(false);
    expect(recordStatus).toHaveBeenCalledWith([
      expect.objectContaining({ name: "cadvisor", state: "retiring", appId: "app-cad", detail: "Stays until the collector has served metrics." }),
    ]);
  });

  it("keeps it while a direct read of the collector fails", async () => {
    settings.set(FIRST_SERVED_KEY, "2026-10-14T00:00:00Z");
    provisioned.readCollector.mockRejectedValue(new Error("collector is stale (last collection 90s ago)"));

    const result = await retireCadvisor(provisioned);

    expect(result).toEqual({ state: "waiting", reason: "Stays while the collector can't be read: collector is stale (last collection 90s ago)" });
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it("removes the app, its status and its incident, then sets the marker", async () => {
    settings.set(FIRST_SERVED_KEY, "2026-10-14T00:00:00Z");

    expect(await retireCadvisor(provisioned)).toEqual({ state: "retired" });

    expect(deleteAppMock).toHaveBeenCalledWith({ appId: "app-cad", organizationId: "vardo-org", allowSystemManaged: true, source: "system" });
    expect(removeStatus).toHaveBeenCalledWith("cadvisor");
    expect(resolveIncident).toHaveBeenCalledWith(["org-a", "vardo-org"], "system.service-down", "cAdvisor", expect.any(String));
    expect(settings.has("cadvisor_retired")).toBe(true);
  });

  it("does nothing the second time", async () => {
    settings.set(FIRST_SERVED_KEY, "2026-10-14T00:00:00Z");
    await retireCadvisor(provisioned);
    expect(await retireCadvisor(provisioned)).toEqual({ state: "done" });
    expect(deleteAppMock).toHaveBeenCalledTimes(1);
    expect(provisioned.readCollector).toHaveBeenCalledTimes(1);
  });

  it("retires without the guard in off mode, where nothing reads cAdvisor", async () => {
    const off = { env: { VARDO_COLLECTOR_IMAGE: "off" }, readCollector: vi.fn() };
    expect(await retireCadvisor(off)).toEqual({ state: "retired" });
    expect(off.readCollector).not.toHaveBeenCalled();
    expect(deleteAppMock).toHaveBeenCalledOnce();
  });

  it("leaves it to the process holding the lock", async () => {
    settings.set(FIRST_SERVED_KEY, "2026-10-14T00:00:00Z");
    lock.held = true;
    expect((await retireCadvisor(provisioned)).state).toBe("waiting");
    expect(deleteAppMock).not.toHaveBeenCalled();
    expect(settings.has("cadvisor_retired")).toBe(false);
  });

  it("never deletes a tenant's own app named cadvisor", async () => {
    settings.set(FIRST_SERVED_KEY, "2026-10-14T00:00:00Z");
    findApp.mockResolvedValue({ ...CADVISOR, isSystemManaged: false });
    expect(await retireCadvisor(provisioned)).toEqual({ state: "retired" });
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it("tries again later when the removal fails", async () => {
    settings.set(FIRST_SERVED_KEY, "2026-10-14T00:00:00Z");
    deleteAppMock.mockRejectedValue(new Error("Could not stop cadvisor"));

    const result = await retireCadvisor(provisioned);

    expect(result).toEqual({ state: "waiting", reason: "Couldn't remove cAdvisor: Could not stop cadvisor" });
    expect(settings.has("cadvisor_retired")).toBe(false);
    expect(removeStatus).not.toHaveBeenCalled();
  });
});

describe("markCollectorServed", () => {
  beforeEach(() => settings.clear());

  it("records the first read only", async () => {
    await markCollectorServed(new Date("2026-10-14T00:00:00Z"));
    await markCollectorServed(new Date("2026-10-15T00:00:00Z"));
    expect(settings.get(FIRST_SERVED_KEY)).toBe("2026-10-14T00:00:00.000Z");
  });
});
