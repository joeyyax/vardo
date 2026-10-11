import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/system-settings", () => ({ getInstanceConfig: async () => null }));

const allowlist: { value: string }[] = [];
let spamhaus = true;
vi.mock("@/lib/probe-guard/allowlist-store", () => ({ getAllowlist: async () => allowlist }));
vi.mock("@/lib/probe-guard/abuse-store", () => ({
  getAbuseSettings: async () => ({ blocklists: { spamhaus: { enabled: spamhaus } } }),
  getDropRanges: async () => ({ ranges: ["198.51.100.0/24", "203.0.113.0/24"], fetchedAt: null }),
}));

import { activeBannedRanges } from "@/lib/probe-guard/sync";

beforeEach(() => {
  allowlist.length = 0;
  spamhaus = true;
});

describe("activeBannedRanges", () => {
  it("drops a range overlapping the current allowlist without waiting for an import", async () => {
    expect(await activeBannedRanges()).toEqual(["198.51.100.0/24", "203.0.113.0/24"]);
    allowlist.push({ value: "198.51.100.7" });
    expect(await activeBannedRanges()).toEqual(["203.0.113.0/24"]);
  });

  it("renders nothing while Spamhaus is off", async () => {
    spamhaus = false;
    expect(await activeBannedRanges()).toEqual([]);
  });
});
