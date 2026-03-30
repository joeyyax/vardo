import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(),
  },
}));

vi.mock("@/lib/docker/client", () => ({
  stopContainer: vi.fn(),
  startContainer: vi.fn(),
  inspectContainer: vi.fn(),
  removeContainer: vi.fn(),
}));

vi.mock("@/lib/docker/deploy-cancel", () => ({
  requestDeploy: vi.fn(),
}));

vi.mock("@/lib/events", () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
  appChannel: vi.fn().mockReturnValue("app:test-app-id"),
}));

vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

import { runAsyncContainerMigration } from "@/lib/docker/import";
import { db } from "@/lib/db";
import {
  stopContainer,
  startContainer,
  inspectContainer,
} from "@/lib/docker/client";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { publishEvent } from "@/lib/events";

// Flush all pending promises and microtasks. Needed because
// runAsyncContainerMigration is fire-and-forget (void return).
function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Build a chainable Drizzle update mock: db.update(t).set(v).where(w)
function makeUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  return { set, where };
}

const BASE_PARAMS = {
  appId: "test-app-id",
  deploymentId: "test-deploy-id",
  orgId: "test-org-id",
  userId: "test-user-id",
  displayName: "Test App",
  activityMetadata: {},
};

// ---------------------------------------------------------------------------
// runAsyncContainerMigration — bailOnFirstStopFailure path
// ---------------------------------------------------------------------------

describe("runAsyncContainerMigration — bailOnFirstStopFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // inspectContainer throws (container not found) so waitForContainerStopped
    // exits immediately rather than polling for 5 seconds.
    vi.mocked(inspectContainer).mockRejectedValue(new Error("Not found"));
  });

  it("marks deployment failed and resets app when the only container fails to stop", async () => {
    vi.mocked(stopContainer).mockRejectedValue(new Error("container is locked"));

    const chain = makeUpdateChain();
    vi.mocked(db.update).mockReturnValue({ set: chain.set } as unknown as ReturnType<typeof db.update>);

    runAsyncContainerMigration({
      ...BASE_PARAMS,
      containerIds: ["c1"],
      bailOnFirstStopFailure: true,
    });
    await flushPromises();

    // No containers were stopped, so startContainer should not be called.
    expect(startContainer).not.toHaveBeenCalled();

    // Deployment should be marked failed.
    expect(db.update).toHaveBeenCalledTimes(2);

    // publishEvent should fire with deploy:failed.
    expect(publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "deploy:failed", appId: BASE_PARAMS.appId }),
    );

    // requestDeploy must NOT be called — abort happened before deploy.
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it("restarts already-stopped containers when a later stop fails", async () => {
    // c1 stops successfully, c2 fails.
    vi.mocked(stopContainer)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("container is locked"));

    const chain = makeUpdateChain();
    vi.mocked(db.update).mockReturnValue({ set: chain.set } as unknown as ReturnType<typeof db.update>);
    vi.mocked(startContainer).mockResolvedValue(undefined);

    runAsyncContainerMigration({
      ...BASE_PARAMS,
      containerIds: ["c1", "c2"],
      bailOnFirstStopFailure: true,
    });
    await flushPromises();

    // c1 was stopped first, so it should be restarted.
    expect(startContainer).toHaveBeenCalledWith("c1");
    expect(startContainer).not.toHaveBeenCalledWith("c2");

    // Deployment marked failed, app reset to active.
    expect(db.update).toHaveBeenCalledTimes(2);

    // Deploy must not have been attempted.
    expect(requestDeploy).not.toHaveBeenCalled();

    // deploy:failed event published.
    expect(publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "deploy:failed", deploymentId: BASE_PARAMS.deploymentId }),
    );
  });

  it("proceeds to deploy when all containers stop successfully", async () => {
    vi.mocked(stopContainer).mockResolvedValue(undefined);
    vi.mocked(requestDeploy).mockResolvedValue({
      success: true,
      deploymentId: BASE_PARAMS.deploymentId,
      log: "",
      durationMs: 0,
    });

    const chain = makeUpdateChain();
    vi.mocked(db.update).mockReturnValue({ set: chain.set } as unknown as ReturnType<typeof db.update>);

    runAsyncContainerMigration({
      ...BASE_PARAMS,
      containerIds: ["c1", "c2"],
      bailOnFirstStopFailure: true,
    });
    await flushPromises();

    expect(requestDeploy).toHaveBeenCalledOnce();
    expect(publishEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "deploy:failed" }),
    );
  });
});
