import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/docker/client", () => ({ dockerRequest: vi.fn() }));

import { isTraefikAutoManaged, nextTraefikLimit } from "@/lib/resources/traefik-auto";

const mib = 1024 ** 2;

describe("Traefik memory growth", () => {
  it("raises a pressured proxy in bounded steps when the host has room", () => {
    expect(nextTraefikLimit({ usageBytes: 480 * mib, limitBytes: 512 * mib, hostUsedBytes: 16 * 1024 * mib, hostTotalBytes: 32 * 1024 * mib })).toBe(768);
  });

  it("holds the limit when pressure is low or host capacity is tight", () => {
    expect(nextTraefikLimit({ usageBytes: 300 * mib, limitBytes: 512 * mib, hostUsedBytes: 0, hostTotalBytes: 32 * 1024 * mib })).toBeNull();
    expect(nextTraefikLimit({ usageBytes: 480 * mib, limitBytes: 512 * mib, hostUsedBytes: 7_500 * mib, hostTotalBytes: 8 * 1024 * mib })).toBeNull();
  });

  it("keeps manual caps pinned, including changes after an automatic increase", () => {
    expect(isTraefikAutoManaged(512, 512, null)).toBe(true);
    expect(isTraefikAutoManaged(1024, 512, null)).toBe(false);
    expect(isTraefikAutoManaged(768, 512, 768)).toBe(true);
    expect(isTraefikAutoManaged(1024, 512, 768)).toBe(false);
  });
});
