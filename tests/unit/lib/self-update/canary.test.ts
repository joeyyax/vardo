import { describe, it, expect } from "vitest";
import { canaryVerdict, sameCommit, type CanaryPeer } from "@/lib/self-update/canary";
import { parseVardoStatus, vardoStatusColumns } from "@/lib/self-update/peer-status";
import type { CanaryPolicy } from "@/lib/self-update/policy";

const NOW = new Date("2026-10-09T12:00:00Z");
const TARGET = "4f1a9b2c0d5e6f708192a3b4c5d6e7f809102132";
const follower: CanaryPolicy = { role: "follower", canaryInstanceId: "inst-canary", soakHours: 24 };

const peer = (over: Partial<CanaryPeer> = {}): CanaryPeer => ({
  instanceId: "inst-canary",
  name: "canary",
  version: TARGET.slice(0, 7),
  versionSince: new Date(NOW.getTime() - 30 * 3_600_000),
  healthy: true,
  lastSeenAt: new Date(NOW.getTime() - 30_000),
  ...over,
});

const verdict = (p: CanaryPeer | null, approvedSha: string | null = null, canary = follower) =>
  canaryVerdict({ canary, targetSha: TARGET, peer: p, approvedSha, now: NOW });

describe("canaryVerdict", () => {
  it("doesn't hold an instance that isn't a follower", () => {
    expect(verdict(null, null, { ...follower, role: "canary" }).ready).toBe(true);
    expect(verdict(null, null, { ...follower, role: "none" }).ready).toBe(true);
  });

  it("lets a follower go once the canary ran the target healthy for the soak period", () => {
    expect(verdict(peer())).toEqual({ ready: true, reason: "canary ran it healthy for 30h" });
  });

  it("waits out the rest of the soak", () => {
    const v = verdict(peer({ versionSince: new Date(NOW.getTime() - 5 * 3_600_000) }));
    expect(v).toEqual({ ready: false, reason: "Waiting: canary has run 4f1a9b2 for 5h of 24h" });
  });

  it("waits while the canary runs another version, is unhealthy, quiet or unknown", () => {
    expect(verdict(peer({ version: "e36c2e3" })).reason).toBe("Waiting for canary to run 4f1a9b2");
    expect(verdict(peer({ healthy: false })).reason).toContain("unhealthy");
    expect(verdict(peer({ lastSeenAt: new Date(NOW.getTime() - 60 * 60_000) })).reason).toContain("offline");
    expect(verdict(peer({ healthy: null })).reason).toContain("doesn't report its health");
    expect(verdict(null).reason).toContain("isn't linked");
  });

  it("takes an admin's approval of the target instead", () => {
    expect(verdict(null, TARGET.slice(0, 7))).toEqual({ ready: true, reason: "Approved by an admin" });
    expect(verdict(null, "e36c2e3").ready).toBe(false);
  });
});

describe("sameCommit", () => {
  it("matches a short sha against a full one", () => {
    expect(sameCommit("4F1A9B2", TARGET)).toBe(true);
    expect(sameCommit("4f1a9b", TARGET)).toBe(false);
    expect(sameCommit(null, TARGET)).toBe(false);
  });
});

describe("peer status", () => {
  it("reads a peer's report and ignores junk", () => {
    expect(parseVardoStatus({ sha: "ABC1234", since: "2026-10-09T00:00:00Z", healthy: true })).toEqual({
      sha: "abc1234",
      since: "2026-10-09T00:00:00.000Z",
      healthy: true,
    });
    expect(parseVardoStatus({ sha: "nope" })).toBeNull();
    expect(parseVardoStatus(undefined)).toBeNull();
    expect(parseVardoStatus({ sha: "abc1234", since: "yesterday", healthy: "yes" })).toEqual({ sha: "abc1234", since: null, healthy: null });
  });

  it("leaves an older peer's columns alone", () => {
    expect(vardoStatusColumns(null)).toEqual({});
    expect(vardoStatusColumns({ sha: "abc1234", since: null, healthy: false })).toEqual({
      vardoSha: "abc1234",
      vardoShaSince: null,
      vardoHealthy: false,
    });
  });
});
