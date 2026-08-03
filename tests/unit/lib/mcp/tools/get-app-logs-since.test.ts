import { describe, expect, it } from "vitest";

import { MAX_SINCE_MS, resolveSince } from "@/lib/mcp/tools/get-app-logs";
import { LOOKBACK_MS } from "@/lib/logging/history";

// The window the tool asks Loki for against the window it admits to covering.
// A `since` past retention returns a fraction of what was asked for, so the
// only safe version of that answer is one that says it was shortened.

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

/** Nanosecond start back to the span it represents. */
function spanMs(window: { start: string }): number {
  return NOW - Number(window.start) / 1_000_000;
}

describe("resolveSince", () => {
  it("caps at the deepest window the log viewer reads, which retention is sized to", () => {
    expect(MAX_SINCE_MS).toBe(Math.max(...LOOKBACK_MS));
  });

  it("passes a window inside the cap through untouched", () => {
    const window = resolveSince("6h", NOW);
    expect(window).toMatchObject({ since: "6h", clamped: false });
    expect(spanMs(window)).toBe(6 * 3600_000);
  });

  it("shortens a window past retention to the cap", () => {
    const window = resolveSince("90d", NOW);
    expect(window.clamped).toBe(true);
    expect(spanMs(window)).toBe(MAX_SINCE_MS);
    expect(spanMs(window)).toBeLessThan(90 * 86400_000);
  });

  it("does not call the widest window it can serve a clamp", () => {
    const window = resolveSince("30d", NOW);
    expect(window).toMatchObject({ since: "30d", clamped: false });
    expect(spanMs(window)).toBe(MAX_SINCE_MS);
  });

  it("falls back to an hour when the duration does not parse", () => {
    const window = resolveSince("last tuesday", NOW);
    expect(window).toMatchObject({ since: "1h", clamped: false });
    expect(spanMs(window)).toBe(3600_000);
  });

  it("reports the window it covered, not the one asked for", () => {
    expect(resolveSince("2160h", NOW).since).toBe("30d");
    expect(resolveSince("45m", NOW).since).toBe("45m");
  });
});

describe("the clamp the response carries", () => {
  // Mirrors the payload the tool builds, so the notice cannot be dropped from
  // it without this failing.
  function payload(since: string) {
    const window = resolveSince(since, NOW);
    return {
      since: window.since,
      ...(window.clamped && {
        requestedSince: since,
        truncated: `Loki keeps ${window.since} of logs, so this covers ${window.since} rather than the ${since} requested.`,
      }),
    };
  }

  it("names both windows once it has shortened one", () => {
    const body = payload("90d");
    expect(body.requestedSince).toBe("90d");
    expect(body.since).toBe("30d");
    expect(body.truncated).toContain("30d");
    expect(body.truncated).toContain("90d");
  });

  it("stays quiet when the whole window was served", () => {
    const body = payload("1h");
    expect(body).toEqual({ since: "1h" });
    expect(body).not.toHaveProperty("truncated");
  });
});
