import { describe, it, expect, beforeEach, vi } from "vitest";

// Issue #741: the interactive integration toggle (provisionForFlag) must await
// the first deploy and roll back the app(s) on failure, all-or-nothing.

const {
  dbMock,
  requestDeployMock,
  deleteAppMock,
  loadTemplatesMock,
  ensureVardoOrgMock,
} = vi.hoisted(() => {
  // insert().values() is awaitable; ensureProject also chains
  // .onConflictDoUpdate().returning() to get the project id.
  const insertFn = vi.fn(() => ({
    values: vi.fn(() => {
      const thenable = { then: (res: (v: unknown) => void) => Promise.resolve([]).then(res) };
      return {
        ...thenable,
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "proj-1" }])),
        })),
      };
    }),
  }));

  const dbMock = {
    insert: insertFn,
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    query: {
      apps: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  };

  const template = (name: string) => ({
    name,
    displayName: name,
    description: name,
    source: "direct",
    deployType: "compose",
    composeContent: "services: {}",
    defaultPort: 8080,
    defaultCpuLimit: null,
    defaultMemoryLimit: null,
    defaultDiskWriteAlertThreshold: null,
  });

  return {
    dbMock,
    requestDeployMock: vi.fn(),
    deleteAppMock: vi.fn().mockResolvedValue({ deleted: true }),
    loadTemplatesMock: vi.fn(async () => [template("glitchtip"), template("loki"), template("promtail")]),
    ensureVardoOrgMock: vi.fn(async () => ({ id: "org-1" })),
  };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/templates/load", () => ({ loadTemplates: loadTemplatesMock }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy: requestDeployMock }));
vi.mock("@/lib/docker/delete-app", () => ({ deleteApp: deleteAppMock }));
vi.mock("@/lib/infra/vardo-org", () => ({ ensureVardoOrg: ensureVardoOrgMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));

import { provisionForFlag } from "@/lib/infra/provision";

describe("provisionForFlag — install rollback (#741)", () => {
  beforeEach(() => {
    requestDeployMock.mockReset();
    deleteAppMock.mockClear();
    dbMock.query.apps.findFirst.mockResolvedValue(null);
  });

  it("does not roll back when the first deploy succeeds", async () => {
    requestDeployMock.mockResolvedValue({ deploymentId: "d1", success: true, log: "", durationMs: 1 });

    await expect(provisionForFlag("error-tracking", true)).resolves.toBeUndefined();
    expect(deleteAppMock).not.toHaveBeenCalled();
  });

  it("rolls back the app and throws when the first deploy fails", async () => {
    requestDeployMock.mockResolvedValue({ deploymentId: "d1", success: false, log: "boom", durationMs: 1 });

    await expect(provisionForFlag("error-tracking", true)).rejects.toThrow(/failed to deploy/i);
    expect(deleteAppMock).toHaveBeenCalledTimes(1);
    expect(deleteAppMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", allowSystemManaged: true }),
    );
  });

  it("rolls back a deploy that throws outright", async () => {
    requestDeployMock.mockRejectedValue(new Error("queue exploded"));

    await expect(provisionForFlag("error-tracking", true)).rejects.toThrow(/failed to deploy/i);
    expect(deleteAppMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back already-installed siblings when a later template fails (all-or-nothing)", async () => {
    // logging → [loki, promtail]: loki deploys, promtail fails.
    requestDeployMock
      .mockResolvedValueOnce({ deploymentId: "d1", success: true, log: "", durationMs: 1 })
      .mockResolvedValueOnce({ deploymentId: "d2", success: false, log: "boom", durationMs: 1 });

    await expect(provisionForFlag("logging", true)).rejects.toThrow(/failed to deploy/i);
    // promtail rolls itself back + loki sibling rolled back = 2.
    expect(deleteAppMock).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for a disabled flag (containers keep running)", async () => {
    await expect(provisionForFlag("error-tracking", false)).resolves.toBeUndefined();
    expect(requestDeployMock).not.toHaveBeenCalled();
    expect(deleteAppMock).not.toHaveBeenCalled();
  });
});
