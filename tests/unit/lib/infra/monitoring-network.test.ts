import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { ensureNetworkMock, connectMock } = vi.hoisted(() => ({
  ensureNetworkMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock("@/lib/docker/client", () => ({ ensureNetwork: ensureNetworkMock, connectToNetwork: connectMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { ensureMonitoringNetwork } from "@/lib/infra/monitoring-network";

describe("ensureMonitoringNetwork", () => {
  const saved = process.env.CONTAINER_ID;

  beforeEach(() => {
    ensureNetworkMock.mockReset().mockResolvedValue(undefined);
    connectMock.mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CONTAINER_ID;
    else process.env.CONTAINER_ID = saved;
  });

  it("creates an internal network and attaches the console", async () => {
    process.env.CONTAINER_ID = "vardo-frontend";
    await ensureMonitoringNetwork();
    expect(ensureNetworkMock).toHaveBeenCalledWith("vardo-monitoring", { internal: true });
    expect(connectMock).toHaveBeenCalledWith("vardo-monitoring", "vardo-frontend");
  });

  it("doesn't attach when the network can't be created", async () => {
    process.env.CONTAINER_ID = "vardo-frontend";
    ensureNetworkMock.mockRejectedValue(new Error("daemon down"));
    await expect(ensureMonitoringNetwork()).resolves.toBeUndefined();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("never throws when attaching fails", async () => {
    process.env.CONTAINER_ID = "vardo-frontend";
    connectMock.mockRejectedValue(new Error("no such container"));
    await expect(ensureMonitoringNetwork()).resolves.toBeUndefined();
  });
});
