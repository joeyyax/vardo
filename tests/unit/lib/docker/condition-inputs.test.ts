import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  apps: {},
  appSecurityScans: {},
  backupJobApps: {},
  backupJobs: {},
  domainCertChecks: {},
  domains: {},
}));

import { backupCoverage, soonestCertPerApp, type CertCheckRow } from "@/lib/docker/condition-inputs";

const CHECKED = new Date("2026-07-31T12:00:00.000Z");

function row(overrides: Partial<CertCheckRow> = {}): CertCheckRow {
  return {
    appId: "app-1",
    domain: "app.example.com",
    sslEnabled: true,
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    checkedAt: CHECKED,
    ...overrides,
  };
}

describe("soonestCertPerApp", () => {
  it("keeps the domain that lapses first", () => {
    const out = soonestCertPerApp([
      row({ domain: "late.example.com", expiresAt: new Date("2026-12-01T00:00:00.000Z") }),
      row({ domain: "early.example.com", expiresAt: new Date("2026-08-05T00:00:00.000Z") }),
    ]);
    expect(out.get("app-1")?.domain).toBe("early.example.com");
  });

  it("keys observations by app", () => {
    const out = soonestCertPerApp([row(), row({ appId: "app-2", domain: "two.example.com" })]);
    expect([...out.keys()].sort()).toEqual(["app-1", "app-2"]);
  });

  it("skips a domain with no readable certificate", () => {
    expect(soonestCertPerApp([row({ expiresAt: null })]).size).toBe(0);
  });

  it("skips a domain with TLS turned off", () => {
    expect(soonestCertPerApp([row({ sslEnabled: false })]).size).toBe(0);
  });

  it("ignores an unreadable domain when a readable one exists", () => {
    const out = soonestCertPerApp([
      row({ domain: "none.example.com", expiresAt: null }),
      row({ domain: "good.example.com" }),
    ]);
    expect(out.get("app-1")?.domain).toBe("good.example.com");
  });

  it("returns nothing when no domain has been checked", () => {
    expect(soonestCertPerApp([]).size).toBe(0);
  });

  it("carries the observation timestamp through for the staleness check", () => {
    expect(soonestCertPerApp([row()]).get("app-1")?.checkedAt).toBe(CHECKED.getTime());
  });
});

describe("backupCoverage", () => {
  const app = { id: "app-1", organizationId: "org-dest" };
  const ran = new Date("2026-07-30T00:00:00.000Z");

  it("ignores a leftover link from another org's job (#873)", () => {
    const { covered } = backupCoverage([app], [
      { appId: "app-1", jobOrgId: "org-src", enabled: true, lastRunAt: ran },
    ]);
    expect(covered.has("app-1")).toBe(false);
  });

  it("counts the app's own org and instance-level jobs", () => {
    const own = backupCoverage([app], [{ appId: "app-1", jobOrgId: "org-dest", enabled: true, lastRunAt: ran }]);
    const instance = backupCoverage([app], [{ appId: "app-1", jobOrgId: null, enabled: true, lastRunAt: null }]);
    expect(own.covered.has("app-1")).toBe(true);
    expect(own.lastRunByApp.get("app-1")).toBe(ran.getTime());
    expect(instance.covered.has("app-1")).toBe(true);
  });

  it("takes the latest run from the app's own jobs only", () => {
    const { lastRunByApp } = backupCoverage([app], [
      { appId: "app-1", jobOrgId: "org-src", enabled: true, lastRunAt: new Date("2026-07-31T00:00:00.000Z") },
      { appId: "app-1", jobOrgId: "org-dest", enabled: true, lastRunAt: ran },
    ]);
    expect(lastRunByApp.get("app-1")).toBe(ran.getTime());
  });
});
