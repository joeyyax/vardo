import { describe, expect, it } from "vitest";
import {
  banDurationMs,
  neverBanReason,
  normalizeIp,
  reachesThreshold,
  remoteBanExpiry,
  windowHits,
} from "@/lib/probe-guard/ban-policy";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";

const S = DEFAULT_INSTANCE_PROBE_GUARD;
const HOUR = 3_600_000;

describe("neverBanReason", () => {
  it.each([
    "10.0.0.5", "10.88.0.3", "172.16.4.1", "172.31.255.255", "192.168.1.10", "127.0.0.1", "::1",
    "100.64.0.1", "100.100.100.100", "169.254.1.1", "fd7a:115c:a1e0::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1",
  ])("never bans private, mesh or Tailscale address %s", (ip) => {
    expect(neverBanReason(ip)).not.toBeNull();
  });

  it.each(["173.245.48.1", "104.16.0.1", "162.158.1.1", "2606:4700::1"])("never bans Cloudflare edge %s", (ip) => {
    expect(neverBanReason(ip)).toBe("Cloudflare edge");
  });

  it("never bans the instance's own address or listed ranges", () => {
    expect(neverBanReason("203.0.113.10", { ownIps: ["203.0.113.10"] })).toBe("this instance");
    expect(neverBanReason("198.51.100.7", { extraRanges: ["198.51.100.0/24"] })).not.toBeNull();
  });

  it("bans ordinary public addresses", () => {
    expect(neverBanReason("203.0.113.10")).toBeNull();
    expect(neverBanReason("2001:db8::1")).toBeNull();
    expect(neverBanReason("172.32.0.1")).toBeNull();
  });

  it("refuses anything that isn't an address", () => {
    expect(neverBanReason("unknown")).not.toBeNull();
    expect(neverBanReason("1.2.3.4`) || Host(`x")).not.toBeNull();
    expect(normalizeIp(" ::FFFF:203.0.113.1 ")).toBe("203.0.113.1");
  });
});

describe("banDurationMs", () => {
  it("starts at an hour and doubles up to a day", () => {
    expect(banDurationMs(0, S)).toBe(1 * HOUR);
    expect(banDurationMs(1, S)).toBe(2 * HOUR);
    expect(banDurationMs(2, S)).toBe(4 * HOUR);
    expect(banDurationMs(4, S)).toBe(16 * HOUR);
    expect(banDurationMs(5, S)).toBe(24 * HOUR);
    expect(banDurationMs(500, S)).toBe(24 * HOUR);
  });
});

describe("threshold window", () => {
  it("counts only hits inside the window", () => {
    const now = 1_000_000_000;
    const windowMs = S.windowMinutes * 60_000;
    const hits = [now - windowMs - 1, now - windowMs + 1, now - 1000, now];
    expect(windowHits(hits, now, windowMs)).toBe(3);
  });

  it("bans at five hits by default", () => {
    expect(reachesThreshold(4, S)).toBe(false);
    expect(reachesThreshold(5, S)).toBe(true);
  });
});

describe("remoteBanExpiry", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("keeps the remote expiry within the local maximum", () => {
    expect(remoteBanExpiry(new Date(now.getTime() + 2 * HOUR), now, S)?.getTime()).toBe(now.getTime() + 2 * HOUR);
    expect(remoteBanExpiry(new Date(now.getTime() + 72 * HOUR), now, S)?.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it("drops a ban that has already expired", () => {
    expect(remoteBanExpiry(new Date(now.getTime() - 1), now, S)).toBeNull();
  });
});
