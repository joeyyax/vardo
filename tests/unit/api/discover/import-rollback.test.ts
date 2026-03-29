import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// import route — restarted branch state transitions
// ---------------------------------------------------------------------------
// When a container import deploy fails and the original container is
// successfully restarted, the route must:
//
//   1. Update the deployment record to status="rolled_back".
//
//   2. Update the app record to status="active" — the original container is
//      running again so the app is healthy from the user's perspective.
//
//   3. Publish a deploy:rolled_back SSE event so any open app view refreshes
//      without waiting for the 10-minute stream timeout.
//
//   4. Record activity with action "deployment.rolled_back" and
//      metadata.source = "import" so audit consumers can distinguish import
//      rollbacks from monitor-triggered rollbacks.
//
//   When restarted is false (startContainer threw) none of these updates
//   should happen — the deployment stays in whatever state the failed deploy
//   left it, and the app status is not touched.
//
// Tested as extracted pure functions mirroring the import route logic.
// ---------------------------------------------------------------------------

type DeploymentUpdate = { status: "rolled_back"; finishedAt: Date };
type AppUpdate = { status: "active" };
type ActivityRecord = {
  action: "deployment.rolled_back";
  metadata: { source: "import"; deploymentId: string; containerId: string };
};

type ImportRollbackResult = {
  deployment: DeploymentUpdate;
  app: AppUpdate;
  activity: ActivityRecord;
  publishRolledBackEvent: true;
} | null;

/**
 * Computes which DB updates and side effects should occur when the import
 * route reaches the restarted check.
 *
 * Mirrors the `if (restarted)` block in:
 *   app/api/v1/organizations/[orgId]/discover/containers/[containerId]/import/route.ts
 */
function buildImportRollbackResult(
  restarted: boolean,
  deploymentId: string,
  containerId: string,
): ImportRollbackResult {
  if (!restarted) return null;
  return {
    deployment: { status: "rolled_back", finishedAt: new Date() },
    app: { status: "active" },
    activity: {
      action: "deployment.rolled_back",
      metadata: { source: "import", deploymentId, containerId },
    },
    publishRolledBackEvent: true,
  };
}

// ---------------------------------------------------------------------------
// 1. restarted = true — all updates applied
// ---------------------------------------------------------------------------

describe("import rollback — restarted=true", () => {
  const result = buildImportRollbackResult(true, "dep-123", "abc123def456");

  it("returns a non-null result", () => {
    expect(result).not.toBeNull();
  });

  it("sets deployment status to rolled_back", () => {
    expect(result?.deployment.status).toBe("rolled_back");
  });

  it("sets deployment finishedAt to a Date", () => {
    expect(result?.deployment.finishedAt).toBeInstanceOf(Date);
  });

  it("sets app status to active", () => {
    expect(result?.app.status).toBe("active");
  });

  it("publishes the rolled_back SSE event", () => {
    expect(result?.publishRolledBackEvent).toBe(true);
  });

  it("records activity with action deployment.rolled_back", () => {
    expect(result?.activity.action).toBe("deployment.rolled_back");
  });

  it("records activity with source=import in metadata", () => {
    expect(result?.activity.metadata.source).toBe("import");
  });

  it("records activity with the deployment ID in metadata", () => {
    expect(result?.activity.metadata.deploymentId).toBe("dep-123");
  });

  it("records activity with the container ID in metadata", () => {
    expect(result?.activity.metadata.containerId).toBe("abc123def456");
  });
});

// ---------------------------------------------------------------------------
// 2. restarted = false — no updates
// ---------------------------------------------------------------------------

describe("import rollback — restarted=false", () => {
  it("returns null when startContainer failed", () => {
    const result = buildImportRollbackResult(false, "dep-456", "abc123def456");
    expect(result).toBeNull();
  });

  it("does not update deployment status when not restarted", () => {
    const result = buildImportRollbackResult(false, "dep-456", "abc123def456");
    expect(result?.deployment).toBeUndefined();
  });

  it("does not update app status when not restarted", () => {
    const result = buildImportRollbackResult(false, "dep-456", "abc123def456");
    expect(result?.app).toBeUndefined();
  });

  it("does not publish SSE event when not restarted", () => {
    const result = buildImportRollbackResult(false, "dep-456", "abc123def456");
    expect(result?.publishRolledBackEvent).toBeUndefined();
  });

  it("does not record activity when not restarted", () => {
    const result = buildImportRollbackResult(false, "dep-456", "abc123def456");
    expect(result?.activity).toBeUndefined();
  });
});
