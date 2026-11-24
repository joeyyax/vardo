import { describe, it, expect, vi, beforeEach } from "vitest";

// The upgrade path off Loki: an existing install keeps Loki and Promtail until
// VictoriaLogs answers and the shipper has delivered, then removes both apps and
// keeps their volumes, once.

const { settings, apps, deleteAppMock, resolveIncident, recordStatus, removeStatus, lock } = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  apps: new Map<string, { id: string; organizationId: string; isSystemManaged: boolean }>(),
  deleteAppMock: vi.fn(),
  resolveIncident: vi.fn(),
  recordStatus: vi.fn(),
  removeStatus: vi.fn(),
  lock: { held: false },
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        // Each lookup is by name; the test keys rows by the name it asks for, in call order.
        findFirst: vi.fn(async () => apps.get(order.shift() ?? "")),
      },
      organizations: { findMany: vi.fn(async () => [{ id: "org-a" }, { id: "vardo-org" }]) },
    },
  },
}));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (_col: unknown, value: string) => {
    order.push(value);
    return value;
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

const order: string[] = [];

import { LOKI_RETIRED_KEY, retireLoki } from "@/lib/infra/retire-loki";

const LOKI = { id: "app-loki", organizationId: "vardo-org", isSystemManaged: true };
const PROMTAIL = { id: "app-promtail", organizationId: "vardo-org", isSystemManaged: true };

const working = () => ({
  loggingEnabled: vi.fn(async () => true),
  victoriaLogsReady: vi.fn(async () => true),
  shipperLastDelivery: vi.fn(async (): Promise<number | null> => 1_795_545_655),
});

describe("retireLoki", () => {
  beforeEach(() => {
    settings.clear();
    order.length = 0;
    lock.held = false;
    vi.clearAllMocks();
    apps.clear();
    apps.set("loki", LOKI);
    apps.set("promtail", PROMTAIL);
    deleteAppMock.mockResolvedValue({ deleted: true });
  });

  it("keeps both while VictoriaLogs doesn't answer, and says why", async () => {
    const deps = { ...working(), victoriaLogsReady: vi.fn(async () => false) };

    expect(await retireLoki(deps)).toEqual({ state: "waiting", reason: "Stays until VictoriaLogs answers." });
    expect(deleteAppMock).not.toHaveBeenCalled();
    expect(recordStatus).toHaveBeenCalledWith([
      expect.objectContaining({ name: "promtail", state: "retiring", appId: "app-promtail" }),
      expect.objectContaining({ name: "loki", state: "retiring", appId: "app-loki" }),
    ]);
  });

  it("keeps both until the shipper has delivered a batch", async () => {
    const deps = { ...working(), shipperLastDelivery: vi.fn(async () => null) };
    expect(await retireLoki(deps)).toEqual({ state: "waiting", reason: "Stays until the log shipper has delivered logs." });
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it("keeps both while the shipper can't be read", async () => {
    const deps = { ...working(), shipperLastDelivery: vi.fn(async () => Promise.reject(new Error("fetch failed"))) };
    expect((await retireLoki(deps)).reason).toBe("Stays while the log shipper can't be read: fetch failed");
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it("removes Promtail, then Loki, keeping their volumes, and sets the marker", async () => {
    expect(await retireLoki(working())).toEqual({ state: "retired" });

    expect(deleteAppMock.mock.calls.map(([o]) => o)).toEqual([
      { appId: "app-promtail", organizationId: "vardo-org", allowSystemManaged: true, deleteVolumes: false, source: "system" },
      { appId: "app-loki", organizationId: "vardo-org", allowSystemManaged: true, deleteVolumes: false, source: "system" },
    ]);
    expect(removeStatus).toHaveBeenCalledWith("promtail");
    expect(removeStatus).toHaveBeenCalledWith("loki");
    expect(resolveIncident).toHaveBeenCalledWith(["org-a", "vardo-org"], "system.service-down", "Loki", expect.any(String));
    expect(resolveIncident).toHaveBeenCalledWith(["org-a", "vardo-org"], "system.service-down", "Promtail", expect.any(String));
    expect(settings.has(LOKI_RETIRED_KEY)).toBe(true);
  });

  it("does nothing the second time", async () => {
    const deps = working();
    await retireLoki(deps);
    expect(await retireLoki(deps)).toEqual({ state: "done" });
    expect(deleteAppMock).toHaveBeenCalledTimes(2);
    expect(deps.victoriaLogsReady).toHaveBeenCalledTimes(1);
  });

  it("retires without the guard with logging off, where nothing reads Loki", async () => {
    const deps = { ...working(), loggingEnabled: vi.fn(async () => false), victoriaLogsReady: vi.fn(async () => false) };
    expect(await retireLoki(deps)).toEqual({ state: "retired" });
    expect(deps.victoriaLogsReady).not.toHaveBeenCalled();
    expect(deleteAppMock).toHaveBeenCalledTimes(2);
  });

  it("never deletes a tenant's own app named loki", async () => {
    apps.set("loki", { ...LOKI, isSystemManaged: false });
    expect(await retireLoki(working())).toEqual({ state: "retired" });
    expect(deleteAppMock.mock.calls.map(([o]) => o.appId)).toEqual(["app-promtail"]);
  });

  it("retires a fresh install with neither app as a no-op", async () => {
    apps.clear();
    expect(await retireLoki(working())).toEqual({ state: "retired" });
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it("leaves it to the process holding the lock", async () => {
    lock.held = true;
    expect((await retireLoki(working())).state).toBe("waiting");
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it("tries again later when a removal fails, before touching Loki", async () => {
    deleteAppMock.mockRejectedValueOnce(new Error("promtail stop timed out"));

    expect(await retireLoki(working())).toEqual({ state: "waiting", reason: "Couldn't remove Promtail: promtail stop timed out" });
    expect(deleteAppMock).toHaveBeenCalledTimes(1);
    expect(settings.has(LOKI_RETIRED_KEY)).toBe(false);
    expect(removeStatus).not.toHaveBeenCalled();
  });
});
