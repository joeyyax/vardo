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

import { soonestCertPerApp, type CertCheckRow } from "@/lib/docker/condition-inputs";

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
