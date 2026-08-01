import { describe, it, expect } from "vitest";

import {
  MAX_SINCE_MS,
  clearChips,
  describeWindow,
  filtersToQuery,
  hasActiveFilters,
  parseFilters,
  parseSince,
  toggleFamily,
  toggleOutcome,
} from "@/lib/activity/filter";

const NOW = new Date("2026-07-31T12:00:00Z");

describe("parseSince", () => {
  it("accepts an ISO timestamp", () => {
    const since = parseSince("2026-07-31T09:00:00.000Z", NOW);
    expect(since?.toISOString()).toBe("2026-07-31T09:00:00.000Z");
  });

  it("returns null for missing or unparseable input", () => {
    expect(parseSince(null, NOW)).toBeNull();
    expect(parseSince("", NOW)).toBeNull();
    expect(parseSince("yesterday-ish", NOW)).toBeNull();
  });

  it("rejects a future timestamp rather than guessing", () => {
    expect(parseSince("2026-08-01T00:00:00Z", NOW)).toBeNull();
  });

  it("clamps a window older than the cap", () => {
    const since = parseSince("2020-01-01T00:00:00Z", NOW);
    expect(since?.getTime()).toBe(NOW.getTime() - MAX_SINCE_MS);
  });

  it("takes the first value when the param repeats", () => {
    const since = parseSince(
      ["2026-07-31T09:00:00.000Z", "2026-07-30T09:00:00.000Z"],
      NOW
    );
    expect(since?.toISOString()).toBe("2026-07-31T09:00:00.000Z");
  });
});

describe("parseFilters", () => {
  it("reads comma-separated families and outcomes", () => {
    const filters = parseFilters({ family: "deploy,security", outcome: "failure" }, NOW);
    expect(filters.families).toEqual(["deploy", "security"]);
    expect(filters.outcomes).toEqual(["failure"]);
  });

  it("reads repeated params", () => {
    const filters = parseFilters({ family: ["deploy", "app"] }, NOW);
    expect(filters.families).toEqual(["deploy", "app"]);
  });

  it("drops unknown values instead of failing", () => {
    const filters = parseFilters({ family: "deploy,nonsense", outcome: "maybe" }, NOW);
    expect(filters.families).toEqual(["deploy"]);
    expect(filters.outcomes).toEqual([]);
  });

  it("deduplicates and lowercases", () => {
    const filters = parseFilters({ family: "Deploy,deploy,DEPLOY" }, NOW);
    expect(filters.families).toEqual(["deploy"]);
  });

  it("yields empty filters for an empty query", () => {
    expect(hasActiveFilters(parseFilters({}, NOW))).toBe(false);
  });
});

describe("filtersToQuery", () => {
  it("round-trips through parseFilters", () => {
    const filters = parseFilters(
      { family: "deploy,app", outcome: "failure", since: "2026-07-31T09:00:00.000Z" },
      NOW
    );
    const query = filtersToQuery(filters);
    const reparsed = parseFilters(
      Object.fromEntries(new URLSearchParams(query)),
      NOW
    );

    expect(reparsed).toEqual(filters);
  });

  it("omits empty values", () => {
    expect(filtersToQuery({ families: [], outcomes: [], since: null })).toBe("");
  });
});

describe("toggles", () => {
  const base = { families: ["deploy" as const], outcomes: [], since: null };

  it("adds a family that is off", () => {
    expect(toggleFamily(base, "app").families).toEqual(["deploy", "app"]);
  });

  it("removes a family that is on", () => {
    expect(toggleFamily(base, "deploy").families).toEqual([]);
  });

  it("adds and removes outcomes", () => {
    const on = toggleOutcome(base, "failure");
    expect(on.outcomes).toEqual(["failure"]);
    expect(toggleOutcome(on, "failure").outcomes).toEqual([]);
  });

  it("leaves the window alone when toggling chips", () => {
    const withWindow = { ...base, since: NOW };
    expect(toggleFamily(withWindow, "app").since).toBe(NOW);
    expect(clearChips(withWindow).since).toBe(NOW);
  });

  it("clears families and outcomes together", () => {
    const cleared = clearChips({
      families: ["deploy"],
      outcomes: ["failure"],
      since: null,
    });
    expect(hasActiveFilters(cleared)).toBe(false);
  });
});

describe("describeWindow", () => {
  it("describes minutes, hours and days", () => {
    expect(describeWindow(new Date(NOW.getTime() - 30 * 60_000), NOW)).toBe(
      "30 minutes"
    );
    expect(describeWindow(new Date(NOW.getTime() - 5 * 3_600_000), NOW)).toBe(
      "5 hours"
    );
    expect(describeWindow(new Date(NOW.getTime() - 4 * 86_400_000), NOW)).toBe(
      "4 days"
    );
  });

  it("uses the singular for one unit", () => {
    expect(describeWindow(new Date(NOW.getTime() - 60_000), NOW)).toBe("1 minute");
  });
});
