import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }));

import { PERMANENT_UNTIL, isPermanent } from "@/lib/probe-guard/permanent";
import { RETENTION_MS, banRenderOrder, isPrunable, remoteBanExpiry } from "@/lib/probe-guard/ban-policy";
import { receiveSharedBan, sharePayload } from "@/lib/probe-guard/mesh-share";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";
import type { BanRequest } from "@/lib/probe-guard/bans";

const now = new Date("2026-01-01T00:00:00Z");
const HOUR = 3_600_000;

describe("permanent sentinel", () => {
  it("survives JSON, ISO strings and Date round-trips", () => {
    const wire = JSON.parse(JSON.stringify({ expiresAt: PERMANENT_UNTIL })) as { expiresAt: string };
    expect(wire.expiresAt).toBe("9999-12-31T00:00:00.000Z");
    expect(isPermanent(wire.expiresAt)).toBe(true);
    expect(isPermanent(new Date(wire.expiresAt))).toBe(true);
    expect(new Date(wire.expiresAt).getTime()).toBe(PERMANENT_UNTIL.getTime());
  });

  it("leaves temporary and malformed expiries alone", () => {
    expect(isPermanent(new Date(now.getTime() + 24 * HOUR))).toBe(false);
    expect(isPermanent("2999-01-01T00:00:00Z")).toBe(false);
    expect(isPermanent("not a date")).toBe(false);
  });
});

describe("banRenderOrder", () => {
  const temp = (ip: string, hoursAgo: number) => ({
    ip,
    createdAt: new Date(now.getTime() - hoursAgo * HOUR),
    expiresAt: new Date(now.getTime() + HOUR),
  });
  const perm = (ip: string, hoursAgo: number) => ({ ...temp(ip, hoursAgo), expiresAt: PERMANENT_UNTIL });

  it("puts permanent bans first, then the newest temporary ones", () => {
    const rows = [temp("203.0.113.1", 1), perm("203.0.113.2", 500), temp("203.0.113.3", 0), perm("203.0.113.4", 2)];
    expect(banRenderOrder(rows, 10)).toEqual(["203.0.113.4", "203.0.113.2", "203.0.113.3", "203.0.113.1"]);
  });

  it("drops the oldest temporary bans at the cap, never a permanent one", () => {
    const rows = [temp("203.0.113.1", 1), temp("203.0.113.2", 2), perm("203.0.113.3", 900)];
    expect(banRenderOrder(rows, 2)).toEqual(["203.0.113.3", "203.0.113.1"]);
  });

  it("lists an address once", () => {
    expect(banRenderOrder([perm("203.0.113.1", 5), temp("203.0.113.1", 1)], 10)).toEqual(["203.0.113.1"]);
  });
});

describe("isPrunable", () => {
  it("keeps permanent bans however old", () => {
    expect(isPrunable({ expiresAt: PERMANENT_UNTIL }, now)).toBe(false);
    expect(isPrunable({ expiresAt: PERMANENT_UNTIL }, new Date("9999-12-30T00:00:00Z"))).toBe(false);
  });

  it("drops temporary bans once past the 90-day retention", () => {
    expect(RETENTION_MS).toBe(90 * 24 * HOUR);
    expect(isPrunable({ expiresAt: new Date(now.getTime() - RETENTION_MS - 1) }, now)).toBe(true);
    expect(isPrunable({ expiresAt: new Date(now.getTime() - 60 * 24 * HOUR) }, now)).toBe(false);
    expect(isPrunable({ expiresAt: new Date(now.getTime() - HOUR) }, now)).toBe(false);
  });
});

describe("sharing a permanent ban", () => {
  it("sends the sentinel and the receiver caps it at its local maximum", async () => {
    const payload = sharePayload({ ip: "203.0.113.9", reason: "threshold", expiresAt: PERMANENT_UNTIL });
    expect(payload?.expiresAt).toBe(PERMANENT_UNTIL.toISOString());

    const bans: BanRequest[] = [];
    await receiveSharedBan({ id: "p1", name: "peer" }, payload, {
      sharingEnabled: async () => true,
      ban: async (req) => {
        bans.push(req);
        return { status: "refused", reason: "test" };
      },
    });
    const expiry = remoteBanExpiry(bans[0].origin!.expiresAt, now, DEFAULT_INSTANCE_PROBE_GUARD);
    expect(expiry?.getTime()).toBe(now.getTime() + DEFAULT_INSTANCE_PROBE_GUARD.maxBanHours * HOUR);
    expect(isPermanent(expiry!)).toBe(false);
  });
});
