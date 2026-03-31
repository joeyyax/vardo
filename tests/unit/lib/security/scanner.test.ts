import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock all external dependencies before importing the module under test.
// ---------------------------------------------------------------------------

const {
  mockFindFirstScan,
  mockFindManyScan,
  mockFindFirstApp,
  mockFindManyApp,
  mockInsert,
  mockInsertValues,
  mockUpdate,
  mockUpdateSet,
  mockUpdateWhere,
  mockDelete,
  mockDeleteWhere,
} = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  // db.update(table).set({...}).where(...) returns a Promise so .catch() works normally.
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  return {
    mockFindFirstScan: vi.fn(),
    mockFindManyScan: vi.fn(),
    mockFindFirstApp: vi.fn(),
    mockFindManyApp: vi.fn(),
    mockInsert,
    mockInsertValues,
    mockUpdate,
    mockUpdateSet,
    mockUpdateWhere,
    mockDelete,
    mockDeleteWhere,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      appSecurityScans: {
        findFirst: mockFindFirstScan,
        findMany: mockFindManyScan,
      },
      apps: {
        findFirst: mockFindFirstApp,
        findMany: mockFindManyApp,
      },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  appSecurityScans: {},
  apps: {},
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

const mockEmit = vi.fn();
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: mockEmit,
}));

vi.mock("@/lib/security/file-exposure", () => ({
  checkFileExposure: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/security/headers", () => ({
  checkSecurityHeaders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/security/tls", () => ({
  checkTls: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/security/ports", () => ({
  checkExposedPorts: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("nanoid", () => ({
  nanoid: () => "test-scan-id",
}));

// ---------------------------------------------------------------------------
// Import after mocks are established.
// ---------------------------------------------------------------------------

import { runSecurityScan, runScheduledScans } from "@/lib/security/scanner";
import { checkFileExposure } from "@/lib/security/file-exposure";
import { checkSecurityHeaders } from "@/lib/security/headers";
import { checkTls } from "@/lib/security/tls";
import { checkExposedPorts } from "@/lib/security/ports";

const mockCheckFileExposure = checkFileExposure as ReturnType<typeof vi.fn>;
const mockCheckSecurityHeaders = checkSecurityHeaders as ReturnType<typeof vi.fn>;
const mockCheckTls = checkTls as ReturnType<typeof vi.fn>;
const mockCheckExposedPorts = checkExposedPorts as ReturnType<typeof vi.fn>;

const baseApp = {
  id: "app-1",
  name: "test-app",
  displayName: "Test App",
  exposedPorts: null,
  domains: [{ domain: "example.com", isPrimary: true, sslEnabled: true }],
};

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults that let most tests succeed without per-test setup.
  mockFindFirstScan.mockResolvedValue(null);   // No running scan
  mockFindManyScan.mockResolvedValue([{ id: "test-scan-id" }]); // For pruning
  mockFindFirstApp.mockResolvedValue(baseApp);
  mockFindManyApp.mockResolvedValue([]);
  mockInsertValues.mockResolvedValue(undefined);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDeleteWhere.mockResolvedValue(undefined);

  // Reset update/insert/delete return values after clearAllMocks resets them.
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockDelete.mockReturnValue({ where: mockDeleteWhere });

  // vi.clearAllMocks does not clear mock implementations — reset checkers
  // explicitly so tests don't bleed into each other.
  mockCheckFileExposure.mockResolvedValue([]);
  mockCheckSecurityHeaders.mockResolvedValue([]);
  mockCheckTls.mockResolvedValue([]);
  mockCheckExposedPorts.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// runSecurityScan
// ---------------------------------------------------------------------------

describe("runSecurityScan", () => {
  describe("happy path", () => {
    it("creates a scan record in running state and returns the scanId", async () => {
      const scanId = await runSecurityScan({
        appId: "app-1",
        organizationId: "org-1",
        trigger: "manual",
      });

      expect(scanId).toBe("test-scan-id");
      expect(mockInsert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test-scan-id",
          appId: "app-1",
          organizationId: "org-1",
          trigger: "manual",
          status: "running",
        }),
      );
    });

    it("persists completed scan with findings and counts", async () => {
      mockCheckTls.mockResolvedValue([
        {
          type: "tls",
          severity: "critical",
          title: "TLS certificate has expired",
          description: "Cert expired",
          detail: "example.com",
        },
      ]);

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "completed",
          criticalCount: 1,
          warningCount: 0,
        }),
      );
    });
  });

  describe("concurrent scan guard", () => {
    it("returns null without creating a new scan when one is already running", async () => {
      mockFindFirstScan.mockResolvedValue({ id: "existing-running-scan" });

      const scanId = await runSecurityScan({
        appId: "app-1",
        organizationId: "org-1",
        trigger: "manual",
      });

      expect(scanId).toBeNull();
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("app not found", () => {
    it("marks the scan as failed and returns null when the app does not exist", async () => {
      mockFindFirstApp.mockResolvedValue(null);

      const scanId = await runSecurityScan({
        appId: "app-1",
        organizationId: "org-1",
        trigger: "manual",
      });

      expect(scanId).toBeNull();
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });
  });

  describe("notifications", () => {
    it("emits a notification when critical findings are present", async () => {
      mockCheckTls.mockResolvedValue([
        {
          type: "tls",
          severity: "critical",
          title: "TLS certificate has expired",
          description: "Cert expired",
          detail: "example.com",
        },
      ]);

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockEmit).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({
          type: "security.scan-findings",
          appId: "app-1",
          criticalCount: 1,
        }),
      );
    });

    it("emits a notification when warning findings are present", async () => {
      mockCheckTls.mockResolvedValue([
        {
          type: "tls",
          severity: "warning",
          title: "TLS certificate expires in 7 days",
          description: "Cert expiring",
          detail: "example.com",
        },
      ]);

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockEmit).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ warningCount: 1 }),
      );
    });

    it("does not emit a notification when there are no critical or warning findings", async () => {
      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockEmit).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// runScheduledScans
// ---------------------------------------------------------------------------

describe("runScheduledScans", () => {
  it("scans active apps that have at least one domain", async () => {
    mockFindManyApp.mockResolvedValue([
      { id: "app-1", name: "app1", status: "active", domains: [{ domain: "example.com" }] },
    ]);

    await runScheduledScans("org-1");

    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("skips inactive apps", async () => {
    mockFindManyApp.mockResolvedValue([
      { id: "app-2", name: "app2", status: "inactive", domains: [{ domain: "example.com" }] },
    ]);

    await runScheduledScans("org-1");

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("skips active apps without domains", async () => {
    mockFindManyApp.mockResolvedValue([
      { id: "app-3", name: "app3", status: "active", domains: [] },
    ]);

    await runScheduledScans("org-1");

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("continues scanning remaining apps when one throws", async () => {
    mockFindManyApp.mockResolvedValue([
      { id: "app-1", name: "app1", status: "active", domains: [{ domain: "first.com" }] },
      { id: "app-2", name: "app2", status: "active", domains: [{ domain: "second.com" }] },
    ]);

    // First scan's DB insert throws — simulates a transient DB error.
    mockInsertValues
      .mockRejectedValueOnce(new Error("DB connection failed"))
      .mockResolvedValue(undefined);

    // Should not throw despite the first app failing.
    await expect(runScheduledScans("org-1")).resolves.toBeUndefined();

    // Both apps were attempted — insert was called for each.
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });
});
