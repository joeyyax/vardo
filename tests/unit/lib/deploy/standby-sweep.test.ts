// ---------------------------------------------------------------------------
// Excalidraw ran both slots for twelve hours after a clean deploy: the daemon
// restarted, restored the stopped standby, and Traefik load-balanced across two
// versions. Nothing noticed. This is the sweep that does.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, redisMock, lockMock, standbyMock } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const selectMock = vi.fn().mockImplementation(() => {
    const result = selectQueue.shift() ?? [];
    const where = vi.fn().mockResolvedValue(result);
    const innerJoin = vi.fn().mockResolvedValue(result);
    return { from: vi.fn().mockReturnValue({ innerJoin, where }) };
  });

  const dbMock = {
    select: selectMock,
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    query: {
      deployments: { findFirst: vi.fn() },
      environments: { findFirst: vi.fn() },
    },
    _selectQueue: selectQueue,
  };

  const store = new Map<string, string>();
  const redisMock = {
    redis: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
        if (args.includes("NX") && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
    },
    _store: store,
  };

  return {
    dbMock,
    redisMock,
    lockMock: { acquireLock: vi.fn().mockResolvedValue(true) },
    standbyMock: {
      SLOTS: ["blue", "green"] as const,
      runningProjects: vi.fn(),
      readCurrentSlot: vi.fn(),
      stopStandbySlot: vi.fn().mockResolvedValue(undefined),
      decideStandbySweep: vi.fn(),
    },
  };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/redis", () => redisMock);
vi.mock("@/lib/redis-lock", () => lockMock);
vi.mock("@/lib/docker/standby-slot", () => standbyMock);
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn() }));
vi.mock("@/lib/docker/rollback-monitor", () => ({
  performRollback: vi.fn(),
  sendRollbackNotification: vi.fn(),
  slotIsDown: vi.fn(),
  slotContainerIds: vi.fn(),
}));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  removeFromQueue: vi.fn(),
  reconcileActiveCounter: vi.fn(),
  reconcileQueue: vi.fn(),
}));
vi.mock("@/lib/docker/deploy", () => ({ stopProject: vi.fn() }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ publishKillSignal: vi.fn() }));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("id") }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { sweepStandbySlots } from "@/lib/deploy/sweeper";
import {
  runningProjects,
  readCurrentSlot,
  stopStandbySlot,
  decideStandbySweep,
} from "@/lib/docker/standby-slot";

const BOTH_SLOTS = new Set(["excalidraw-production-blue", "excalidraw-production-green"]);

/** An app whose last deploy finished well outside the standby grace period. */
function settledApp() {
  dbMock._selectQueue.push([
    {
      appId: "app-1",
      appName: "excalidraw",
      appStatus: "active",
      organizationId: "org-1",
      envName: "production",
    },
  ]);
  dbMock.query.deployments.findFirst.mockResolvedValue({
    status: "success",
    finishedAt: new Date(Date.now() - 12 * 60 * 60_000),
  });
}

describe("sweepStandbySlots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectQueue.length = 0;
    redisMock._store.clear();
    lockMock.acquireLock.mockResolvedValue(true);
    vi.mocked(runningProjects).mockResolvedValue(BOTH_SLOTS);
    vi.mocked(readCurrentSlot).mockResolvedValue("green");
    vi.mocked(decideStandbySweep).mockReturnValue({ act: true, standby: "blue" });
  });

  it("stops the standby the symlink does not name", async () => {
    settledApp();
    await sweepStandbySlots();

    expect(stopStandbySlot).toHaveBeenCalledWith(
      expect.stringContaining("excalidraw"),
      "excalidraw-production",
      "blue",
    );
  });

  it("refuses to act when the live slot cannot be identified", async () => {
    settledApp();
    vi.mocked(readCurrentSlot).mockResolvedValue(null);
    vi.mocked(decideStandbySweep).mockReturnValue({
      act: false,
      refused: true,
      reason: "no 'current' symlink to identify the live slot",
    });

    await sweepStandbySlots();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });

  it("costs one Docker read and no DB work when no app runs both slots", async () => {
    vi.mocked(runningProjects).mockResolvedValue(
      new Set(["excalidraw-production-green", "paperless-production-blue"]),
    );

    await sweepStandbySlots();
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });

  it("leaves everything alone when Docker could not be read", async () => {
    vi.mocked(runningProjects).mockResolvedValue(null);

    await sweepStandbySlots();
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });

  it("leaves both slots up while a deploy owns the app", async () => {
    settledApp();
    redisMock._store.set("deploy:active:app-1", JSON.stringify({ deploymentId: "d-1" }));

    await sweepStandbySlots();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });

  it("leaves both slots up when the app row still reads as deploying", async () => {
    dbMock._selectQueue.push([
      {
        appId: "app-1",
        appName: "excalidraw",
        appStatus: "deploying",
        organizationId: "org-1",
        envName: "production",
      },
    ]);

    await sweepStandbySlots();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });

  it("gives a fresh deploy its overlap before calling the standby stranded", async () => {
    dbMock._selectQueue.push([
      {
        appId: "app-1",
        appName: "excalidraw",
        appStatus: "active",
        organizationId: "org-1",
        envName: "production",
      },
    ]);
    dbMock.query.deployments.findFirst.mockResolvedValue({
      status: "success",
      finishedAt: new Date(Date.now() - 60_000),
    });

    await sweepStandbySlots();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });

  it("refuses when one prefix matches more than one app and environment", async () => {
    // `${appName}-${envName}` is not uniquely decodable when either name has a
    // dash, and the wrong owner means stopping another app's live slot.
    dbMock._selectQueue.push([
      {
        appId: "app-1",
        appName: "excalidraw",
        appStatus: "active",
        organizationId: "org-1",
        envName: "production",
      },
      {
        appId: "app-2",
        appName: "excalidraw-production",
        appStatus: "active",
        organizationId: "org-1",
        envName: "",
      },
    ]);

    await sweepStandbySlots();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });

  it("does not act twice across instances holding the same lock", async () => {
    settledApp();
    lockMock.acquireLock.mockResolvedValue(false);

    await sweepStandbySlots();
    expect(stopStandbySlot).not.toHaveBeenCalled();
  });
});
