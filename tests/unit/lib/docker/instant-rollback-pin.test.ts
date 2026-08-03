// ---------------------------------------------------------------------------
// A cutover pin outranks the app's Docker routers and names the slot the
// rollback is leaving. Vardo's own deploy leaves one behind by design — its stop
// kills the process before the release — so the rollback has to drop it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, execFileAsyncMock, execFileMock, cutoverMock, order } = vi.hoisted(() => {
  const order: string[] = [];

  const dbMock = {
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    insert: vi.fn().mockImplementation(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    query: { deployments: { findFirst: vi.fn().mockResolvedValue(null) } },
  };

  const execFileAsyncMock = vi.fn();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileAsyncMock,
    configurable: true,
    writable: true,
  });

  return {
    order,
    dbMock,
    execFileAsyncMock,
    execFileMock,
    cutoverMock: {
      clearCutoverPin: vi.fn(async () => { order.push("clear-pin"); }),
    },
  };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/docker/traefik-cutover", () => cutoverMock);
vi.mock("@/lib/docker/restart-policy", () => ({
  demoteStandbyRestart: vi.fn().mockResolvedValue(undefined),
  restoreSlotRestart: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/compose", () => ({
  slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]),
}));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn().mockResolvedValue("green") }));
vi.mock("@/lib/docker/shared-project", () => ({ readSlotPartition: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn().mockResolvedValue("id") }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("fs/promises", () => ({
  rm: vi.fn().mockResolvedValue(undefined),
  symlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import { performInstantRollback } from "@/lib/docker/instant-rollback";
import type { ResolvedEnv } from "@/lib/docker/resolve-env";

const OPTS = {
  appId: "app-1",
  appName: "vardo",
  organizationId: "org-1",
  userId: "user-1",
  env: { id: "env-1", name: "production", type: "production" } as ResolvedEnv,
};

describe("performInstantRollback — cutover pin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    execFileAsyncMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("stop")) {
        order.push("stop-active");
        return { stdout: "", stderr: "" };
      }
      if (args.includes("ps")) {
        return {
          stdout: JSON.stringify({ Service: "web", Name: "vardo-production-blue-web-1", State: "running" }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
  });

  it("drops the pin before the active slot stops serving", async () => {
    const result = await performInstantRollback(OPTS);

    expect(result.success).toBe(true);
    expect(cutoverMock.clearCutoverPin).toHaveBeenCalledWith("vardo", "production");
    expect(order).toEqual(["clear-pin", "stop-active"]);
  });

  it("rolls back even when the pin cannot be removed", async () => {
    cutoverMock.clearCutoverPin.mockRejectedValueOnce(new Error("read-only volume"));

    await expect(performInstantRollback(OPTS)).resolves.toMatchObject({ success: true });
  });
});
