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
    expect(j).toMatchObject({ state: "passing", credit: 1, evidence: "2 of 2 valid. Soonest expiry Nov 28." });
  });
  it("is partial with one invalid among valid, failing with none valid", () => {
    expect(judgeHttps([ok("a.dev"), { domain: "b.dev", tls: "invalid", expiresAt: null }]).state).toBe("partial");
    expect(judgeHttps([{ domain: "b.dev", tls: "no-https", expiresAt: null }]).state).toBe("failing");
  });
  it("counts only answered domains and says how many didn't answer", () => {
    const silent = { domain: "x.dev", tls: "unreachable" as const, expiresAt: null };
    const domains = [...Array.from({ length: 42 }, (_, i) => ok(`d${i}.dev`)), ...Array.from({ length: 5 }, () => silent)];
    const j = judgeHttps(domains);
    expect(j.state).toBe("passing");
    expect(j.evidence.startsWith("42 of 42 valid. 5 domains didn't answer on port 443.")).toBe(true);
  });
  it("is partial with credit valid over answered when an answered domain is invalid", () => {
    const j = judgeHttps([ok("a.dev"), ok("b.dev"), ok("c.dev"), { domain: "d.dev", tls: "invalid", expiresAt: null }, { domain: "e.dev", tls: "unreachable", expiresAt: null }]);
    expect(j.state).toBe("partial");
    expect(j.credit).toBeCloseTo(0.75);
    expect(j.evidence).toContain("3 of 4 valid. 1 domain didn't answer");
  });
  it("is unknown, earning nothing, when no domain answered", () => {
    const j = judgeHttps([{ domain: "b.dev", tls: "unreachable", expiresAt: null }]);
    expect(j.state).toBe("unknown");
    expect(j.credit).toBeUndefined();
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
    expect(j.credit).toBe(0.5);
  });
  it("widens the window for a weekly job", () => {
    const weekly = job([{ status: "success", h: 100 }], { intervalMs: 7 * 86_400_000 });
    expect(judgeNightlyBackups([weekly], now).state).toBe("passing");
  });
});

describe("judgeBackupsProtected", () => {
  const job = (latest: { encrypted: boolean; offHost: boolean } | null) => ({ name: "j", enabled: true, latest });
  const both = { encrypted: true, offHost: true };
  it("passes with full credit only when encrypted and off the host", () => {
    expect(judgeBackupsProtected([job(both)])).toMatchObject({ state: "passing", credit: 1 });
  });
  it("averages the encrypted and off-host fractions", () => {
    expect(judgeBackupsProtected([job({ encrypted: true, offHost: false })])).toMatchObject({ state: "partial", credit: 0.5 });
    expect(judgeBackupsProtected([job(both), job({ encrypted: false, offHost: true }), job({ encrypted: false, offHost: true }), job(both)])).toMatchObject({ state: "partial", credit: 0.75 });
  });
  it("fails with no credit when nothing is encrypted or off the host", () => {
    expect(judgeBackupsProtected([job({ encrypted: false, offHost: false })])).toMatchObject({ state: "failing", credit: 0 });
  });
  it("counts a job without an archive as unprotected, and is unknown when none has one", () => {
    expect(judgeBackupsProtected([job(null)]).state).toBe("unknown");
    expect(judgeBackupsProtected([job(both), job(null)])).toMatchObject({ state: "partial", credit: 0.5 });
  });
});

describe("judgeUpdated", () => {
  const behind = (over: Partial<{ auto: boolean; targetCommittedAt: Date | null }> = {}) => ({
    kind: "behind" as const, version: "1.0", target: "abc1234", mode: "automatic", auto: true, targetCommittedAt: hoursAgo(2), ...over,
  });
  it("fails when the channel is ahead and unknown when it can't be read", () => {
    expect(judgeUpdated(behind({ auto: false }), now).state).toBe("failing");
    expect(judgeUpdated({ kind: "unknown", reason: "x" }, now).state).toBe("unknown");
    expect(judgeUpdated({ kind: "current", version: "1.0" }, now).state).toBe("passing");
  });
  it("passes when auto-update is on and the newer commit is under 24 hours old", () => {
    expect(judgeUpdated(behind(), now).state).toBe("passing");
    expect(judgeUpdated(behind({ targetCommittedAt: hoursAgo(23.9) }), now).state).toBe("passing");
  });
  it("fails once the commit is 24 hours old, or when its age is unknown", () => {
    expect(judgeUpdated(behind({ targetCommittedAt: hoursAgo(24) }), now).state).toBe("failing");
    expect(judgeUpdated(behind({ targetCommittedAt: null }), now).state).toBe("failing");
  });
  it("fails a fresh commit when updates aren't automatic", () => {
    expect(judgeUpdated(behind({ auto: false }), now).state).toBe("failing");
  });
});

describe("judgeTwoStep", () => {
  it("counts a passkey or TOTP, and says password sign-in isn't blocked", () => {
    const j = judgeTwoStep([{ twoFactor: true, passkeys: 0 }, { twoFactor: false, passkeys: 2 }, { twoFactor: false, passkeys: 0 }]);
    expect(j.state).toBe("partial");
    expect(j.evidence).toContain("2 of 3 members");
    expect(j.credit).toBeCloseTo(2 / 3);
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
    expect(judgeProbeGuard({ apps: 3, enabled: 1, keyAvailable: true })).toMatchObject({ state: "partial", credit: 1 / 3 });
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
    expect(judgeRestoreTested(jobs, [drill("a", "x", 2), drill("b", "y", 8)], now)).toMatchObject({ state: "partial", credit: 0.5 });
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
