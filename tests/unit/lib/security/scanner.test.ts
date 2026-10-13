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
  ne: vi.fn(),
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

const { mockFingerprintApp, mockRecordRecognized } = vi.hoisted(() => ({
  mockFingerprintApp: vi.fn(),
  mockRecordRecognized: vi.fn(),
}));

vi.mock("@/lib/security/template-fingerprint", () => ({
  fingerprintApp: mockFingerprintApp,
}));

vi.mock("@/lib/probe-guard/recommendations", () => ({
  recordRecognized: mockRecordRecognized,
}));

const { mockNormalizeAppProbeGuard } = vi.hoisted(() => ({
  mockNormalizeAppProbeGuard: vi.fn((raw: { templates?: string[] } | null | undefined) => ({
    enabled: true,
    exceptions: [],
    rules: {},
    blocks: [],
    templates: raw && Array.isArray(raw.templates) ? raw.templates : [],
    robotsTxt: false,
  })),
}));

vi.mock("@/lib/probe-guard/settings", () => ({
  normalizeAppProbeGuard: mockNormalizeAppProbeGuard,
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

import { diffFindings, runSecurityScan, runScheduledScans } from "@/lib/security/scanner";
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
  imageName: null,
  composeContent: null,
  parentAppId: null,
  probeGuard: { enabled: true, exceptions: [], rules: {}, blocks: [], templates: [], robotsTxt: false },
  domains: [{ domain: "example.com", isPrimary: true, sslEnabled: true }],
  childApps: [],
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
  mockFingerprintApp.mockResolvedValue({ recognizedIds: [] });
  mockRecordRecognized.mockResolvedValue(undefined);
  mockNormalizeAppProbeGuard.mockImplementation((raw: { templates?: string[] } | null | undefined) => ({
    enabled: true,
    exceptions: [],
    rules: {},
    blocks: [],
    templates: raw && Array.isArray(raw.templates) ? raw.templates : [],
    robotsTxt: false,
  }));
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

    it("reports a clean manual scan too, since someone asked for it", async () => {
      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockEmit).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ trigger: "manual", criticalCount: 0, apps: [expect.objectContaining({ appId: "app-1", findings: [] })] }),
      );
    });

    it("stays quiet after a deploy when nothing changed since the last scan", async () => {
      mockFindFirstScan.mockResolvedValueOnce(null).mockResolvedValueOnce({ findings: [hsts] });
      mockCheckSecurityHeaders.mockResolvedValue([hsts]);

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "deploy" });

      expect(mockEmit).not.toHaveBeenCalled();
    });

    it("reports only the new finding after a deploy", async () => {
      mockFindFirstScan.mockResolvedValueOnce(null).mockResolvedValueOnce({ findings: [hsts] });
      mockCheckSecurityHeaders.mockResolvedValue([hsts]);
      mockCheckFileExposure.mockResolvedValue([envFile]);

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "deploy" });

      expect(mockEmit).toHaveBeenCalledTimes(1);
      const event = mockEmit.mock.calls[0][1];
      expect(event.apps).toEqual([
        { appId: "app-1", appName: "Test App", domain: "example.com", findings: [{ severity: "critical", title: ".env is served", description: "Secrets are public." }] },
      ]);
    });
  });

  describe("template fingerprinting", () => {
    it("calls recordRecognized with the guard's applied templates and the recognized ids", async () => {
      mockFingerprintApp.mockResolvedValue({ recognizedIds: ["wordpress"] });
      mockFindFirstApp.mockResolvedValueOnce({
        ...baseApp,
        probeGuard: { ...baseApp.probeGuard, templates: ["laravel"] },
      });

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockRecordRecognized).toHaveBeenCalledTimes(1);
      expect(mockRecordRecognized).toHaveBeenCalledWith("app-1", ["wordpress"], ["laravel"]);
    });

    it("passes the app's imageName, composeContent and child images to fingerprintApp", async () => {
      mockFindFirstApp.mockResolvedValueOnce({
        ...baseApp,
        imageName: "wordpress:6",
        composeContent: "services:\n  db:\n    image: 'postgres:16'\n",
        childApps: [{ imageName: "redis:7" }],
      });

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockFingerprintApp).toHaveBeenCalledTimes(1);
      const input = mockFingerprintApp.mock.calls[0][0];
      expect(input.appId).toBe("app-1");
      expect(input.imageName).toBe("wordpress:6");
      expect(input.composeContent).toContain("postgres:16");
      expect(input.childImages).toEqual(["redis:7"]);
      expect(input.domain).toBe("example.com");
    });

    it("does not call recordRecognized when fingerprint found nothing", async () => {
      mockFingerprintApp.mockResolvedValue({ recognizedIds: [] });

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockRecordRecognized).not.toHaveBeenCalled();
    });

    it("uses the top-level app id for recordRecognized when this is a compose child", async () => {
      mockFingerprintApp.mockResolvedValue({ recognizedIds: ["wordpress"] });
      // parentAppId is just a column read; recordRecognized should always get app.id.
      mockFindFirstApp.mockResolvedValueOnce({ ...baseApp, parentAppId: "parent-app-id" });

      await runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" });

      expect(mockRecordRecognized).toHaveBeenCalledWith("app-1", ["wordpress"], expect.anything());
    });

    it("ignores fingerprint failures without failing the scan", async () => {
      mockFingerprintApp.mockRejectedValue(new Error("network down"));

      await expect(runSecurityScan({ appId: "app-1", organizationId: "org-1", trigger: "manual" })).resolves.toBeTruthy();
      expect(mockRecordRecognized).not.toHaveBeenCalled();
    });
  });
});

const hsts = { type: "missing-header" as const, severity: "warning" as const, title: "Missing HSTS", description: "No Strict-Transport-Security header." };
const envFile = { type: "file-exposure" as const, severity: "critical" as const, title: ".env is served", description: "Secrets are public." };
const csp = { type: "missing-header" as const, severity: "info" as const, title: "Missing CSP", description: "No Content-Security-Policy header." };

describe("diffFindings", () => {
  it("counts a finding as news when it's new or its severity changed", () => {
    expect(diffFindings([hsts], [hsts, envFile]).fresh).toEqual([envFile]);
    expect(diffFindings([{ ...hsts, severity: "info" }], [hsts]).fresh).toEqual([hsts]);
    expect(diffFindings([hsts, envFile], [hsts]).fresh).toEqual([]);
  });

  it("never treats info as news", () => {
    expect(diffFindings([], [csp]).fresh).toEqual([]);
  });

  it("counts what went away", () => {
    expect(diffFindings([hsts, envFile], [hsts]).resolved).toBe(1);
  });

  it("treats everything as new on an app's first scan", () => {
    expect(diffFindings(null, [hsts, csp]).fresh).toEqual([hsts]);
  });
});

// ---------------------------------------------------------------------------
// runScheduledScans
// ---------------------------------------------------------------------------

describe("runScheduledScans", () => {
  const twoApps = [
    { id: "app-1", name: "app1", status: "active", domains: [{ domain: "first.example.com" }] },
    { id: "app-2", name: "app2", status: "active", domains: [{ domain: "second.example.com" }] },
  ];

  it("sends nothing when no app has anything new", async () => {
    mockFindManyApp.mockResolvedValue(twoApps);
    mockFindFirstScan.mockImplementation(async (opts?: { columns?: { findings?: boolean } }) => (opts?.columns?.findings ? { findings: [hsts] } : null));
    mockCheckSecurityHeaders.mockResolvedValue([hsts]);

    await runScheduledScans("org-1");

    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("sends one email for the batch, listing each app's new findings", async () => {
    mockFindManyApp.mockResolvedValue(twoApps);
    mockFindFirstScan.mockImplementation(async (opts?: { columns?: { findings?: boolean } }) => (opts?.columns?.findings ? { findings: [] } : null));
    mockCheckSecurityHeaders.mockResolvedValue([hsts]);

    await runScheduledScans("org-1");

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const event = mockEmit.mock.calls[0][1];
    expect(event).toMatchObject({ type: "security.scan-findings", trigger: "scheduled", scanned: 2, warningCount: 2 });
    expect(event.apps.map((a: { appId: string }) => a.appId)).toEqual(["app-1", "app-2"]);
  });

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
