import { describe, expect, it } from "vitest";

import { clampIdleDays, DEFAULT_CONFIG } from "@/lib/docker/image-reclaim/settings";
import { DEFAULT_IDLE_DAYS } from "@/lib/docker/image-reclaim/policy";

describe("image reclaim settings", () => {
  it("keeps the scheduled sweep off until someone turns it on", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_CONFIG.idleDays).toBe(DEFAULT_IDLE_DAYS);
  });

  it("keeps the slot sweep off until someone turns it on", () => {
    expect(DEFAULT_CONFIG.slots).toBe(false);
  });

  it("clamps the threshold into range", () => {
    expect(clampIdleDays(0)).toBe(1);
    expect(clampIdleDays(-1)).toBe(1);
    expect(clampIdleDays(99999)).toBe(3650);
    expect(clampIdleDays(45)).toBe(45);
  });

  it("falls back to the default for junk", () => {
    expect(clampIdleDays("nonsense")).toBe(DEFAULT_IDLE_DAYS);
    expect(clampIdleDays(undefined)).toBe(DEFAULT_IDLE_DAYS);
  });

  it("floors fractional days", () => {
    expect(clampIdleDays(30.9)).toBe(30);
  });
});
