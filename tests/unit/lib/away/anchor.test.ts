import { describe, it, expect } from "vitest";

import { resolveSince, MAX_WINDOW_MS } from "@/lib/away";

const NOW = new Date("2026-07-31T20:00:00Z");

describe("resolveSince", () => {
  it("reports nothing on a first visit", () => {
    expect(resolveSince(null, NOW)).toBeNull();
  });

  it("uses the anchor when it is inside the cap", () => {
    const anchor = new Date(NOW.getTime() - 3 * 24 * 60 * 60_000);
    expect(resolveSince(anchor, NOW)).toEqual(anchor);
  });

  it("clamps an anchor older than the cap", () => {
    const ancient = new Date(NOW.getTime() - 90 * 24 * 60 * 60_000);
    expect(resolveSince(ancient, NOW)).toEqual(
      new Date(NOW.getTime() - MAX_WINDOW_MS),
    );
  });
});
