import { describe, it, expect } from "vitest";
import { buildOverview, type AppRow, type LatestScan, type ScanRow } from "@/lib/security/overview";
import type { SecurityFinding } from "@/lib/db/schema/security";

const finding = (over: Partial<SecurityFinding>): SecurityFinding => ({
  type: "missing-header",
  severity: "warning",
  title: "x",
  description: "y",
  ...over,
});

describe("buildOverview", () => {
  it("returns empty totals when no scans exist", () => {
    const result = buildOverview({ scans: [], scanRows: [], appRows: [], orgNameById: {}, topN: 2 });
    expect(result.worst).toEqual([]);
    expect(result.totals).toEqual({ apps: 0, critical: 0, warning: 0, info: 0 });
  });

  it("aggregates critical, warning and info counts across all scans", () => {
    const scans: LatestScan[] = [
      { appId: "a1", scanId: "s1", scannedAt: new Date("2025-01-01") },
      { appId: "a2", scanId: "s2", scannedAt: new Date("2025-01-02") },
    ];
    const scanRows: ScanRow[] = [
      {
        id: "s1",
        criticalCount: 1,
        warningCount: 2,
        scannedAt: new Date("2025-01-01"),
        findings: [finding({ severity: "critical" }), finding({ severity: "warning" }), finding({ severity: "warning" })],
      },
      {
        id: "s2",
        criticalCount: 0,
        warningCount: 0,
        scannedAt: new Date("2025-01-02"),
        findings: [finding({ severity: "info" }), finding({ severity: "info" })],
      },
    ];
    const appRows: AppRow[] = [
      { id: "a1", appName: "Site", appSlug: "site", organizationId: "o1" },
      { id: "a2", appName: "Portal", appSlug: "portal", organizationId: "o1" },
    ];
    const result = buildOverview({ scans, scanRows, appRows, orgNameById: { o1: "Acme" }, topN: 5 });
    expect(result.totals).toEqual({ apps: 2, critical: 1, warning: 2, info: 2 });
  });

  it("puts criticals first, then warnings, breaking ties by recency", () => {
    const scans: LatestScan[] = [
      { appId: "a1", scanId: "s1", scannedAt: new Date("2025-01-01") },
      { appId: "a2", scanId: "s2", scannedAt: new Date("2025-01-03") },
      { appId: "a3", scanId: "s3", scannedAt: new Date("2025-01-02") },
    ];
    const scanRows: ScanRow[] = [
      { id: "s1", criticalCount: 1, warningCount: 0, scannedAt: new Date("2025-01-01"), findings: [finding({ severity: "critical" })] },
      { id: "s2", criticalCount: 1, warningCount: 1, scannedAt: new Date("2025-01-03"), findings: [finding({ severity: "critical" }), finding({ severity: "warning" })] },
      { id: "s3", criticalCount: 0, warningCount: 1, scannedAt: new Date("2025-01-02"), findings: [finding({ severity: "warning" })] },
    ];
    const appRows: AppRow[] = [
      { id: "a1", appName: "Old", appSlug: "old", organizationId: "o1" },
      { id: "a2", appName: "Newest", appSlug: "newest", organizationId: "o1" },
      { id: "a3", appName: "Mid", appSlug: "mid", organizationId: "o1" },
    ];
    const result = buildOverview({ scans, scanRows, appRows, orgNameById: { o1: "Acme" }, topN: 5 });
    expect(result.worst.map((a) => a.appName)).toEqual(["Newest", "Old", "Mid"]);
  });

  it("respects topN and skips apps without findings", () => {
    const scans: LatestScan[] = [
      { appId: "a1", scanId: "s1", scannedAt: new Date("2025-01-01") },
      { appId: "a2", scanId: "s2", scannedAt: new Date("2025-01-02") },
      { appId: "a3", scanId: "s3", scannedAt: new Date("2025-01-03") },
    ];
    const scanRows: ScanRow[] = [
      { id: "s1", criticalCount: 1, warningCount: 0, scannedAt: new Date("2025-01-01"), findings: [finding({ severity: "critical" })] },
      { id: "s2", criticalCount: 0, warningCount: 2, scannedAt: new Date("2025-01-02"), findings: [finding({ severity: "warning" }), finding({ severity: "warning" })] },
      { id: "s3", criticalCount: 0, warningCount: 0, scannedAt: new Date("2025-01-03"), findings: [] },
    ];
    const appRows: AppRow[] = [
      { id: "a1", appName: "Critical", appSlug: "critical", organizationId: "o1" },
      { id: "a2", appName: "Warning", appSlug: "warning", organizationId: "o1" },
      { id: "a3", appName: "Clean", appSlug: "clean", organizationId: "o1" },
    ];
    const result = buildOverview({ scans, scanRows, appRows, orgNameById: { o1: "Acme" }, topN: 1 });
    expect(result.worst.map((a) => a.appName)).toEqual(["Critical"]);
    expect(result.topN).toBe(1);
  });

  it("skips apps that the joins filtered out", () => {
    const scans: LatestScan[] = [
      { appId: "a1", scanId: "s1", scannedAt: new Date("2025-01-01") },
      { appId: "missing", scanId: "s2", scannedAt: new Date("2025-01-02") },
    ];
    const scanRows: ScanRow[] = [
      { id: "s1", criticalCount: 1, warningCount: 0, scannedAt: new Date("2025-01-01"), findings: [finding({ severity: "critical" })] },
    ];
    const appRows: AppRow[] = [{ id: "a1", appName: "Site", appSlug: "site", organizationId: "o1" }];
    const result = buildOverview({ scans, scanRows, appRows, orgNameById: { o1: "Acme" }, topN: 5 });
    expect(result.worst).toHaveLength(1);
    expect(result.worst[0].appName).toBe("Site");
  });
});