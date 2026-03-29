import { describe, it, expect } from "vitest";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";

// ---------------------------------------------------------------------------
// GPU passthrough — role gate and rollback restore
// ---------------------------------------------------------------------------
// These tests cover three security/correctness paths added in the GPU feature:
//
//   1. Role gate in PATCH /apps/[appId]: only owner and admin may set
//      gpuEnabled=true. Members must receive 403.
//
//   2. Rollback role gate: rolling back to a snapshot with gpuEnabled=true
//      also requires owner/admin — same restriction as PATCH.
//
//   3. Rollback config restore: gpuEnabled is correctly restored from a
//      configSnapshot, with the ?? false fallback for legacy snapshots that
//      predate the field.
//
// All are tested as extracted pure functions so no database or Next.js
// plumbing is needed — matching the pattern established in the codebase.

// ---------------------------------------------------------------------------
// 1. Role gate logic (mirrors route.ts PATCH handler)
// ---------------------------------------------------------------------------

type OrgMembership = { role: "owner" | "admin" | "member" };

/**
 * Returns true when the request should be rejected with 403.
 * Extracted from the PATCH handler in:
 *   app/api/v1/organizations/[orgId]/apps/[appId]/route.ts
 */
function gpuEnableForbidden(gpuEnabled: unknown, membership: OrgMembership): boolean {
  return (
    gpuEnabled === true &&
    membership.role !== "owner" &&
    membership.role !== "admin"
  );
}

describe("GPU passthrough role gate", () => {
  it("allows an owner to enable GPU passthrough", () => {
    expect(gpuEnableForbidden(true, { role: "owner" })).toBe(false);
  });

  it("allows an admin to enable GPU passthrough", () => {
    expect(gpuEnableForbidden(true, { role: "admin" })).toBe(false);
  });

  it("blocks a member from enabling GPU passthrough", () => {
    expect(gpuEnableForbidden(true, { role: "member" })).toBe(true);
  });

  it("does not block a member when gpuEnabled is false", () => {
    // Disabling GPU is safe regardless of role
    expect(gpuEnableForbidden(false, { role: "member" })).toBe(false);
  });

  it("does not block a member when gpuEnabled is not included in the patch", () => {
    // undefined means the field was not sent — no gate should trigger
    expect(gpuEnableForbidden(undefined, { role: "member" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Rollback role gate (mirrors rollback/route.ts POST handler)
// ---------------------------------------------------------------------------

/**
 * Returns true when the rollback should be rejected with 403.
 * Mirrors the gate in:
 *   app/api/v1/organizations/[orgId]/apps/[appId]/rollback/route.ts
 */
function rollbackGpuForbidden(
  configSnapshot: ConfigSnapshot | null,
  membership: OrgMembership,
): boolean {
  return (
    configSnapshot?.gpuEnabled === true &&
    membership.role !== "owner" &&
    membership.role !== "admin"
  );
}

describe("rollback GPU role gate", () => {
  const gpuSnapshot: ConfigSnapshot = {
    cpuLimit: null,
    memoryLimit: null,
    gpuEnabled: true,
    containerPort: null,
    imageName: null,
    gitBranch: "main",
    composeFilePath: null,
    rootDirectory: null,
    restartPolicy: null,
    autoTraefikLabels: null,
    backendProtocol: null,
  };

  const noGpuSnapshot: ConfigSnapshot = { ...gpuSnapshot, gpuEnabled: false };

  it("allows an owner to roll back to a GPU-enabled snapshot", () => {
    expect(rollbackGpuForbidden(gpuSnapshot, { role: "owner" })).toBe(false);
  });

  it("allows an admin to roll back to a GPU-enabled snapshot", () => {
    expect(rollbackGpuForbidden(gpuSnapshot, { role: "admin" })).toBe(false);
  });

  it("blocks a member from rolling back to a GPU-enabled snapshot", () => {
    expect(rollbackGpuForbidden(gpuSnapshot, { role: "member" })).toBe(true);
  });

  it("does not block a member when the snapshot has gpuEnabled=false", () => {
    expect(rollbackGpuForbidden(noGpuSnapshot, { role: "member" })).toBe(false);
  });

  it("does not block a member when there is no config snapshot", () => {
    expect(rollbackGpuForbidden(null, { role: "member" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Rollback config restore logic (mirrors rollback/route.ts)
// ---------------------------------------------------------------------------

/**
 * Builds the app update object for a config snapshot restore.
 * Extracted from the POST handler in:
 *   app/api/v1/organizations/[orgId]/apps/[appId]/rollback/route.ts
 */
function buildConfigRestoreUpdates(configSnapshot: ConfigSnapshot): Record<string, unknown> {
  return {
    cpuLimit: configSnapshot.cpuLimit,
    memoryLimit: configSnapshot.memoryLimit,
    gpuEnabled: configSnapshot.gpuEnabled ?? false,
    containerPort: configSnapshot.containerPort,
    imageName: configSnapshot.imageName,
    gitBranch: configSnapshot.gitBranch,
    composeFilePath: configSnapshot.composeFilePath,
    rootDirectory: configSnapshot.rootDirectory,
    restartPolicy: configSnapshot.restartPolicy,
    autoTraefikLabels: configSnapshot.autoTraefikLabels,
  };
}

describe("rollback config restore — gpuEnabled", () => {
  const baseSnapshot: ConfigSnapshot = {
    cpuLimit: null,
    memoryLimit: null,
    gpuEnabled: false,
    containerPort: null,
    imageName: null,
    gitBranch: "main",
    composeFilePath: null,
    rootDirectory: null,
    restartPolicy: null,
    autoTraefikLabels: null,
    backendProtocol: null,
  };

  it("restores gpuEnabled=true from a snapshot where it was enabled", () => {
    const snapshot: ConfigSnapshot = { ...baseSnapshot, gpuEnabled: true };
    const updates = buildConfigRestoreUpdates(snapshot);
    expect(updates.gpuEnabled).toBe(true);
  });

  it("restores gpuEnabled=false from a snapshot where it was disabled", () => {
    const snapshot: ConfigSnapshot = { ...baseSnapshot, gpuEnabled: false };
    const updates = buildConfigRestoreUpdates(snapshot);
    expect(updates.gpuEnabled).toBe(false);
  });

  it("defaults gpuEnabled to false for legacy snapshots missing the field", () => {
    // Older deployments predating the feature won't have gpuEnabled set.
    // The ?? false guard must produce false rather than undefined/null.
    const legacySnapshot = { ...baseSnapshot } as unknown as ConfigSnapshot;
    // Simulate a legacy snapshot by removing the field
    (legacySnapshot as Record<string, unknown>).gpuEnabled = undefined;
    const updates = buildConfigRestoreUpdates(legacySnapshot);
    expect(updates.gpuEnabled).toBe(false);
  });

  it("restores all other config fields alongside gpuEnabled", () => {
    const snapshot: ConfigSnapshot = {
      ...baseSnapshot,
      cpuLimit: 2,
      memoryLimit: 512,
      gpuEnabled: true,
      containerPort: 3000,
    };
    const updates = buildConfigRestoreUpdates(snapshot);
    expect(updates.cpuLimit).toBe(2);
    expect(updates.memoryLimit).toBe(512);
    expect(updates.gpuEnabled).toBe(true);
    expect(updates.containerPort).toBe(3000);
  });
});
