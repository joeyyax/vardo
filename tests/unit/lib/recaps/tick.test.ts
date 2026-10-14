import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const mocks = vi.hoisted(() => ({ emit: vi.fn(), collect: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: mocks.emit }));
vi.mock("@/lib/docker/client", () => ({ getVolumeSizes: async () => new Map() }));
vi.mock("@/lib/time-zone-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/time-zone-settings")>()),
  getInstanceTimeZone: async () => "UTC",
  getOrgTimeZone: async () => "UTC",
}));
vi.mock("@/lib/recaps/collect", () => ({ collectRecap: mocks.collect, volumeSizes: async () => new Map() }));

import { dbMock } from "@/tests/helpers/db";
import { RECAP_FIXTURES } from "@/lib/email/fixtures";
const { scheduleRecaps, tickRecaps } = await import("@/lib/recaps/tick");

const now = new Date("2026-10-16T09:00:00Z");
const deployedAt = new Date("2026-10-13T08:00:00Z");

/** Scripts `db.select(...)...where()` to resolve the due rows. */
function dueRows(rows: unknown[]) {
  const chain = { from: () => chain, innerJoin: () => chain, where: async () => rows };
  (dbMock.db as unknown as { select: () => typeof chain }).select = () => chain;
}

const due = (appId: string, extra: Record<string, unknown> = {}) => ({
  appId,
  organizationId: "org1",
  kind: "72h",
  deployedAt,
  status: "active",
  parked: false,
  ...extra,
});

describe("tickRecaps", () => {
  beforeEach(() => {
    dbMock.reset();
    vi.clearAllMocks();
    dbMock.query.organizations.findMany.mockResolvedValue([{ id: "org1", name: "Example Home", timeZone: null }]);
    mocks.collect.mockImplementation(async (row: { appId: string; kind: string }) => ({ ...RECAP_FIXTURES.clean, appId: row.appId, kind: row.kind }));
  });

  it("sends every recap due in an org as one email", async () => {
    dueRows([due("a"), due("b")]);
    dbMock.updateReturns([{ appId: "a", kind: "72h" }, { appId: "b", kind: "72h" }]);
    await tickRecaps(now);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    const [org, event] = mocks.emit.mock.calls[0]!;
    expect(org).toBe("org1");
    expect(event.type).toBe("digest.app-recap");
    expect(event.recaps.map((r: { appId: string }) => r.appId)).toEqual(["a", "b"]);
    expect(dbMock.updates.at(-1)!.set).toEqual({ outcome: "sent", finishedAt: now });
  });

  it("never sends a recap another pass already claimed", async () => {
    dueRows([due("a"), due("b")]);
    dbMock.updateReturns([{ appId: "b", kind: "72h" }]);
    await tickRecaps(now);
    expect(mocks.emit.mock.calls[0]![1].recaps.map((r: { appId: string }) => r.appId)).toEqual(["b"]);

    mocks.emit.mockClear();
    dbMock.updateReturns([]);
    await tickRecaps(now);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("finishes a stopped app's recap without sending it", async () => {
    dueRows([due("a", { status: "stopped" })]);
    dbMock.updateReturns([{ appId: "a", kind: "72h" }]);
    await tickRecaps(now);
    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.updates[0]!.set).toEqual({ outcome: "stopped", finishedAt: now });
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("does nothing when nothing is due", async () => {
    dueRows([]);
    await tickRecaps(now);
    expect(dbMock.updates).toHaveLength(0);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe("scheduleRecaps", () => {
  beforeEach(() => dbMock.reset());

  const app = (extra: Record<string, unknown> = {}) => ({
    id: "a",
    organizationId: "org1",
    parentAppId: null,
    isSystemManaged: false,
    organization: { isSystemManaged: false },
    ...extra,
  });
  const prod = { environmentId: null, groupEnvironmentId: null };

  it("arms both recaps for a production app and returns the 72-hour send time", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(app());
    dbMock.query.appRecaps.findFirst.mockResolvedValue({ outcome: null, dueAt: new Date("2026-10-16T09:00:00Z") });
    const at = await scheduleRecaps("a", prod, deployedAt);
    expect(at?.toISOString()).toBe("2026-10-16T09:00:00.000Z");
    const values = dbMock.inserts[0]!.values as { kind: string; dueAt: Date }[];
    expect(values.map((v) => [v.kind, v.dueAt.toISOString()])).toEqual([
      ["72h", "2026-10-16T09:00:00.000Z"],
      ["30d", "2026-11-12T09:00:00.000Z"],
    ]);
  });

  it("arms nothing for a compose child, Vardo service or preview", async () => {
    for (const extra of [{ parentAppId: "p" }, { isSystemManaged: true }, { organization: { isSystemManaged: true } }]) {
      dbMock.query.apps.findFirst.mockResolvedValue(app(extra));
      expect(await scheduleRecaps("a", prod, deployedAt)).toBeUndefined();
    }
    dbMock.query.apps.findFirst.mockResolvedValue(app());
    dbMock.query.environments.findFirst.mockResolvedValue({ type: "preview" });
    expect(await scheduleRecaps("a", { environmentId: "e1", groupEnvironmentId: null }, deployedAt)).toBeUndefined();
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("promises no date once the 72-hour recap is finished", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue(app());
    dbMock.query.appRecaps.findFirst.mockResolvedValue({ outcome: "sent", dueAt: new Date("2026-10-16T09:00:00Z") });
    expect(await scheduleRecaps("a", prod, deployedAt)).toBeUndefined();
  });
});
