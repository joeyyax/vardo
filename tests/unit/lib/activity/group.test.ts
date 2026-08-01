import { describe, it, expect } from "vitest";

import { groupActivities, isFleetWide } from "@/lib/activity/group";
import { classifyAll } from "@/lib/activity/taxonomy";
import type { ActivityRow } from "@/lib/activity/types";

const BASE = new Date("2026-07-31T12:00:00Z").getTime();

/** Minutes before the base instant, so callers read newest-first naturally. */
function at(minutesAgo: number): Date {
  return new Date(BASE - minutesAgo * 60_000);
}

let seq = 0;
function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    action: "deployment.succeeded",
    metadata: null,
    createdAt: at(0),
    user: { id: "u1", name: "Joey", email: "joey@example.com", image: null },
    app: { id: "app-1", name: "paperless", displayName: "Paperless" },
    ...overrides,
  };
}

function group(rows: ActivityRow[]) {
  // Fixed day key keeps the test independent of the runner's timezone.
  return groupActivities(classifyAll(rows), { dayKey: () => "day" });
}

describe("groupActivities", () => {
  it("collapses a run of the same action on the same subject", () => {
    const groups = group([
      row({ createdAt: at(0) }),
      row({ createdAt: at(1) }),
      row({ createdAt: at(2) }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].subjects).toHaveLength(1);
    expect(isFleetWide(groups[0])).toBe(false);
  });

  it("reports the span of a collapsed run oldest to newest", () => {
    const [only] = group([
      row({ createdAt: at(0) }),
      row({ createdAt: at(4) }),
    ]);

    expect(only.lastAt).toEqual(at(0));
    expect(only.firstAt).toEqual(at(4));
  });

  it("collapses one action across many subjects into a fleet row", () => {
    const groups = group([
      row({ createdAt: at(0), app: { id: "a", name: "a", displayName: "Alpha" } }),
      row({ createdAt: at(1), app: { id: "b", name: "b", displayName: "Beta" } }),
      row({ createdAt: at(2), app: { id: "c", name: "c", displayName: "Gamma" } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(isFleetWide(groups[0])).toBe(true);
    expect(groups[0].subjects.map((s) => s.label)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("never merges a failure into a run of successes", () => {
    const groups = group([
      row({ createdAt: at(0) }),
      row({ createdAt: at(1), action: "deployment.failed", metadata: { error: "boom" } }),
      row({ createdAt: at(2) }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[1].outcome).toBe("failure");
  });

  it("keeps different actors apart", () => {
    const groups = group([
      row({ createdAt: at(0) }),
      row({
        createdAt: at(1),
        user: { id: "u2", name: "Sam", email: "sam@example.com", image: null },
      }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("keeps automated rows apart from a person's rows", () => {
    const groups = group([
      row({ createdAt: at(0), user: null }),
      row({ createdAt: at(1) }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].actor).toBeNull();
  });

  it("does not merge different actions", () => {
    const groups = group([
      row({ createdAt: at(0), action: "deployment.succeeded" }),
      row({ createdAt: at(1), action: "deployment.started" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("breaks a bucket when the gap between events is too long", () => {
    const groups = group([row({ createdAt: at(0) }), row({ createdAt: at(30) })]);

    expect(groups).toHaveLength(2);
  });

  it("stops a slow trickle from becoming one row", () => {
    const rows = [];
    for (let i = 0; i <= 20; i += 1) rows.push(row({ createdAt: at(i * 4) }));

    const groups = group(rows);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) {
      expect(g.lastAt.getTime() - g.firstAt.getTime()).toBeLessThanOrEqual(
        60 * 60_000
      );
    }
  });

  it("never spans two day headings", () => {
    const groups = groupActivities(
      classifyAll([row({ createdAt: at(0) }), row({ createdAt: at(1) })]),
      { dayKey: (d) => (d.getTime() === at(0).getTime() ? "today" : "yesterday") }
    );

    expect(groups).toHaveLength(2);
  });

  it("keeps the newest error and counts distinct ones", () => {
    const groups = group([
      row({ createdAt: at(0), action: "deployment.failed", metadata: { error: "newest" } }),
      row({ createdAt: at(1), action: "deployment.failed", metadata: { error: "older" } }),
      row({ createdAt: at(2), action: "deployment.failed", metadata: { error: "older" } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].error).toBe("newest");
    expect(groups[0].errorVariants).toBe(2);
  });

  it("keeps a lone event addressable as a single", () => {
    const [only] = group([row({ createdAt: at(0) })]);

    expect(only.count).toBe(1);
    expect(only.single).toBeDefined();
    expect(only.single?.action).toBe("deployment.succeeded");
  });

  it("drops the single once events collapse", () => {
    const [only] = group([row({ createdAt: at(0) }), row({ createdAt: at(1) })]);

    expect(only.single).toBeUndefined();
  });

  it("returns nothing for an empty list", () => {
    expect(group([])).toEqual([]);
  });

  it("preserves newest-first order across groups", () => {
    const groups = group([
      row({ createdAt: at(0), action: "app.created" }),
      row({ createdAt: at(30), action: "app.updated" }),
      row({ createdAt: at(90), action: "app.deleted", app: null, metadata: { name: "x" } }),
    ]);

    const times = groups.map((g) => g.lastAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
