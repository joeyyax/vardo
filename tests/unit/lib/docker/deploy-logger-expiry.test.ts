import { describe, it, expect, vi, beforeEach } from "vitest";

const { addMock, expireMock } = vi.hoisted(() => ({
  addMock: vi.fn().mockResolvedValue("1-0"),
  expireMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/stream/producer", () => ({ addDeployLog: addMock }));
vi.mock("@/lib/stream/deploy-expiry", () => ({ expireDeployStream: expireMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { createDeployLogger } from "@/lib/docker/deploy-logger";

beforeEach(() => vi.clearAllMocks());

describe("deploy logger stream expiry", () => {
  it("expires the stream when the deploy completes", async () => {
    const l = createDeployLogger("d1");
    l.stage("done", "success");
    await l.flush();
    expect(expireMock).toHaveBeenCalledWith("d1");
  });

  it("expires the stream on failed and cancelled", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      expireMock.mockClear();
      const l = createDeployLogger(`d-${status}`);
      l.stage("build", status);
      await l.flush();
      expect(expireMock).toHaveBeenCalledWith(`d-${status}`);
    }
  });

  it("leaves the stream alone for non-terminal events", async () => {
    const l = createDeployLogger("d2");
    l.stage("build", "running");
    l.stage("build", "success");
    l.log("hello");
    await l.flush();
    expect(expireMock).not.toHaveBeenCalled();
  });

  it("does not throw when the expiry fails", async () => {
    expireMock.mockRejectedValueOnce(new Error("redis down"));
    const l = createDeployLogger("d3");
    l.stage("done", "success");
    await expect(l.flush()).resolves.toBeUndefined();
  });
});
