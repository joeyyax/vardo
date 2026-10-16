import { describe, expect, it } from "vitest";
import {
  judgeBackupsProtected,
  judgeHttps,
  judgeNightlyBackups,
  judgeProbeGuard,
  judgeRestoreTested,
  judgeSecurityContact,
  judgeTwoStep,
  judgeUpdated,
} from "@/lib/trust/judge";

const now = new Date("2026-10-16T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

describe("judgeSecurityContact", () => {
  it("fails with an empty or blank contact", () => {
    expect(judgeSecurityContact("").state).toBe("failing");
    expect(judgeSecurityContact("  ").state).toBe("failing");
  });
  it("passes with a contact and names it", () => {
    expect(judgeSecurityContact("a@b.co")).toEqual({ state: "passing", evidence: "Reports go to a@b.co." });
  });
});

describe("judgeHttps", () => {
  const ok = (domain: string) => ({ domain, tls: "valid" as const, expiresAt: daysAgo(-30) });
  it("is unknown with no domains", () => {
    expect(judgeHttps([]).state).toBe("unknown");
  });
  it("passes when all are valid and names the soonest expiry", () => {
    const j = judgeHttps([
      { ...ok("a.dev"), expiresAt: new Date("2027-01-02T00:00:00Z") },
      { ...ok("b.dev"), expiresAt: new Date("2026-11-28T00:00:00Z") },
    ]);
    expect(j).toEqual({ state: "passing", evidence: "2 of 2 valid. Soonest expiry Nov 28." });
  });
  it("is partial with one invalid among valid, failing with none valid", () => {
    expect(judgeHttps([ok("a.dev"), { domain: "b.dev", tls: "invalid", expiresAt: null }]).state).toBe("partial");
    expect(judgeHttps([{ domain: "b.dev", tls: "no-https", expiresAt: null }]).state).toBe("failing");
  });
  it("is unknown, not passing, when a domain didn't answer", () => {
    expect(judgeHttps([ok("a.dev"), { domain: "b.dev", tls: "unreachable", expiresAt: null }]).state).toBe("unknown");
  });
});

describe("judgeNightlyBackups", () => {
  const job = (runs: { status: string; h: number }[], extra = {}) => ({
    name: "j",
    enabled: true,
    intervalMs: 86_400_000,
    runs: runs.map((r) => ({ status: r.status, startedAt: hoursAgo(r.h) })),
    ...extra,
  });
  it("fails with no enabled job", () => {
    expect(judgeNightlyBackups([job([], { enabled: false })], now).state).toBe("failing");
  });
  it("passes when each job has a success in the window", () => {
    expect(judgeNightlyBackups([job([{ status: "success", h: 10 }])], now).state).toBe("passing");
  });
  it("ignores a success older than the window", () => {
    expect(judgeNightlyBackups([job([{ status: "success", h: 40 }])], now).state).toBe("failing");
  });
  it("counts a failure in the window against the job even beside a success", () => {
    const j = judgeNightlyBackups([job([{ status: "success", h: 10 }, { status: "failed", h: 9 }])], now);
    expect(j.state).toBe("failing");
  });
  it("is partial when some jobs pass", () => {
    const j = judgeNightlyBackups([job([{ status: "success", h: 3 }]), job([{ status: "failed", h: 3 }])], now);
    expect(j.state).toBe("partial");
  });
  it("widens the window for a weekly job", () => {
    const weekly = job([{ status: "success", h: 100 }], { intervalMs: 7 * 86_400_000 });
    expect(judgeNightlyBackups([weekly], now).state).toBe("passing");
  });
});

describe("judgeBackupsProtected", () => {
  const job = (latest: { encrypted: boolean; offHost: boolean } | null) => ({ name: "j", enabled: true, latest });
  it("passes only when encrypted and off the host", () => {
    expect(judgeBackupsProtected([job({ encrypted: true, offHost: true })]).state).toBe("passing");
    expect(judgeBackupsProtected([job({ encrypted: true, offHost: false })]).state).toBe("failing");
    expect(judgeBackupsProtected([job({ encrypted: false, offHost: true })]).state).toBe("failing");
  });
  it("is partial when one job is protected and another isn't", () => {
    expect(judgeBackupsProtected([job({ encrypted: true, offHost: true }), job({ encrypted: false, offHost: true })]).state).toBe("partial");
  });
  it("is unknown when no job has an archive, partial when only some lack one", () => {
    expect(judgeBackupsProtected([job(null)]).state).toBe("unknown");
    expect(judgeBackupsProtected([job({ encrypted: true, offHost: true }), job(null)]).state).toBe("partial");
  });
});

describe("judgeUpdated", () => {
  it("fails when the channel is ahead and unknown when it can't be read", () => {
    expect(judgeUpdated({ kind: "behind", version: "1.0", target: "1.1", mode: "notify only" }).state).toBe("failing");
    expect(judgeUpdated({ kind: "unknown", reason: "x" }).state).toBe("unknown");
    expect(judgeUpdated({ kind: "current", version: "1.0" }).state).toBe("passing");
  });
});

describe("judgeTwoStep", () => {
  it("counts a passkey or TOTP, and says password sign-in isn't blocked", () => {
    const j = judgeTwoStep([{ twoFactor: true, passkeys: 0 }, { twoFactor: false, passkeys: 2 }, { twoFactor: false, passkeys: 0 }]);
    expect(j.state).toBe("partial");
    expect(j.evidence).toContain("2 of 3 members");
  });
  it("is unknown with no members", () => {
    expect(judgeTwoStep([]).state).toBe("unknown");
  });
});

describe("judgeProbeGuard", () => {
  it("fails without the guard key even when every app has it on", () => {
    expect(judgeProbeGuard({ apps: 3, enabled: 3, keyAvailable: false }).state).toBe("failing");
  });
  it("tallies apps", () => {
    expect(judgeProbeGuard({ apps: 3, enabled: 3, keyAvailable: true }).state).toBe("passing");
    expect(judgeProbeGuard({ apps: 3, enabled: 1, keyAvailable: true }).state).toBe("partial");
    expect(judgeProbeGuard({ apps: 3, enabled: 0, keyAvailable: true }).state).toBe("failing");
    expect(judgeProbeGuard({ apps: 0, enabled: 0, keyAvailable: true }).state).toBe("unknown");
  });
});

describe("judgeRestoreTested", () => {
  const jobs = [{ id: "a", enabled: true }, { id: "b", enabled: true }];
  const drill = (jobId: string, volumeKey: string, days: number | null, outcome: string | null = "verified") => ({
    jobId,
    volumeKey,
    verifiedAt: days === null ? null : daysAgo(days),
    verifyOutcome: outcome,
  });
  it("passes when every job's volumes were verified in 7 days", () => {
    expect(judgeRestoreTested(jobs, [drill("a", "x", 2), drill("b", "y", 6)], now).state).toBe("passing");
  });
  it("fails a job whose verification is 8 days old or failed", () => {
    expect(judgeRestoreTested(jobs, [drill("a", "x", 2), drill("b", "y", 8)], now).state).toBe("partial");
    expect(judgeRestoreTested(jobs, [drill("a", "x", 1, "failed"), drill("b", "y", 1, "failed")], now).state).toBe("failing");
  });
  it("needs every volume of a job verified", () => {
    const j = judgeRestoreTested([jobs[0]], [drill("a", "x", 1), drill("a", "z", null, null)], now);
    expect(j.state).toBe("failing");
  });
  it("accepts an older archive's verification for a volume that has a newer untested one", () => {
    const j = judgeRestoreTested([jobs[0]], [drill("a", "x", 3), drill("a", "x", null, null)], now);
    expect(j.state).toBe("passing");
  });
  it("fails a job with no archives", () => {
    expect(judgeRestoreTested([jobs[0]], [], now).state).toBe("failing");
  });
});

describe("next-step titles with no backup jobs", () => {
  it("names the missing setup, not failing jobs", () => {
    expect(judgeNightlyBackups([], now).fix).toBe("Set up nightly backups");
    expect(judgeBackupsProtected([]).fix).toBe("Back up to encrypted, off-host storage");
    expect(judgeRestoreTested([], [], now).fix).toBe("Set up backups to restore-test");
  });
  it("leaves the default title when jobs exist", () => {
    const job = { name: "j", enabled: true, intervalMs: 86_400_000, runs: [{ status: "failed", startedAt: hoursAgo(2) }] };
    expect(judgeNightlyBackups([job], now).fix).toBeUndefined();
  });
});
