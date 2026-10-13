import { describe, expect, it } from "vitest";
import { extractBanRank, RANK_WINDOW_MS } from "@/lib/probe-guard/overview";

describe("extractBanRank", () => {
  it("numbers bans in chronological order within the window", () => {
    const bans = [
      { id: "b3", ip: "203.0.113.7", createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "b1", ip: "203.0.113.7", createdAt: new Date("2025-12-20T00:00:00Z") },
      { id: "b2", ip: "203.0.113.7", createdAt: new Date("2025-12-25T00:00:00Z") },
    ];
    expect(extractBanRank(bans[0], bans)).toBe(3);
    expect(extractBanRank(bans[1], bans)).toBe(1);
    expect(extractBanRank(bans[2], bans)).toBe(2);
  });

  it("ignores bans outside the window", () => {
    const within = { id: "w", ip: "203.0.113.8", createdAt: new Date("2026-01-01T00:00:00Z") };
    const stale = { id: "s", ip: "203.0.113.8", createdAt: new Date(within.createdAt.getTime() - (RANK_WINDOW_MS + 86_400_000)) };
    expect(extractBanRank(within, [within, stale])).toBe(1);
  });

  it("returns 0 when the ban id is not in the list", () => {
    const other = { id: "x", ip: "203.0.113.9", createdAt: new Date("2026-01-01T00:00:00Z") };
    expect(extractBanRank(other, [{ id: "y", ip: "203.0.113.9", createdAt: other.createdAt }])).toBe(0);
  });

  it("only counts bans for the same address", () => {
    const ban = { id: "m", ip: "203.0.113.10", createdAt: new Date("2026-01-01T00:00:00Z") };
    const others = [
      { id: "a", ip: "203.0.113.11", createdAt: new Date(ban.createdAt.getTime() - 1000) },
      { id: "b", ip: "203.0.113.12", createdAt: new Date(ban.createdAt.getTime() - 2000) },
    ];
    expect(extractBanRank(ban, [ban, ...others])).toBe(1);
  });
});