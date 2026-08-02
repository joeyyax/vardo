import { describe, it, expect } from "vitest";

import {
  conditionRows,
  isInlineRow,
  summarize,
  INLINE_SUBJECT_LIMIT,
} from "@/lib/ui/attention";
import type { AppCondition } from "@/lib/docker/conditions";

function app(name: string, conditions: AppCondition[]) {
  return { id: `id-${name}`, name, displayName: name, conditions };
}

const crashLoop: AppCondition = {
  kind: "crash-looping",
  severity: "critical",
  since: "2026-01-01T00:00:00.000Z",
  detail: "7 restarts in 10 minutes",
};

const memory: AppCondition = {
  kind: "memory-pressure",
  severity: "warning",
  since: "2026-01-02T00:00:00.000Z",
  detail: "94% of memory limit",
};

describe("conditionRows", () => {
  it("groups apps under one row per condition kind", () => {
    const rows = conditionRows([app("alpha", [crashLoop]), app("beta", [crashLoop, memory])]);

    expect(rows.map((r) => r.key)).toEqual(["crash-looping", "memory-pressure"]);
    expect(rows[0].items.map((i) => i.name)).toEqual(["alpha", "beta"]);
    expect(rows[1].items).toHaveLength(1);
  });

  it("carries the detail and since of each condition onto its item", () => {
    const [row] = conditionRows([app("alpha", [crashLoop])]);

    expect(row.items[0]).toMatchObject({
      href: "/apps/alpha",
      detail: "7 restarts in 10 minutes",
      since: crashLoop.since,
    });
  });

  it("gives a row the error tone as soon as one app is critical", () => {
    const warningOnly = { ...crashLoop, severity: "warning" as const };
    const rows = conditionRows([app("alpha", [warningOnly]), app("beta", [crashLoop])]);

    expect(rows[0].tone).toBe("error");
  });

  it("keeps a row without a critical app on the warning tone", () => {
    const rows = conditionRows([app("alpha", [memory])]);

    expect(rows[0].tone).toBe("warning");
  });

  it("ignores apps with no conditions", () => {
    expect(conditionRows([{ id: "1", name: "alpha", displayName: "alpha", conditions: null }])).toEqual(
      [],
    );
  });
});

describe("isInlineRow", () => {
  const row = (count: number) => ({
    key: "k",
    label: "Crash loop",
    tone: "error" as const,
    items: Array.from({ length: count }, (_, i) => ({ id: `${i}`, name: `${i}`, href: "/" })),
  });

  it("shows a short row inline", () => {
    expect(isInlineRow(row(1))).toBe(true);
    expect(isInlineRow(row(INLINE_SUBJECT_LIMIT))).toBe(true);
  });

  it("collapses a row past the limit", () => {
    expect(isInlineRow(row(INLINE_SUBJECT_LIMIT + 1))).toBe(false);
  });
});

describe("summarize", () => {
  const row = (
    key: string,
    tone: "error" | "warning" | "neutral",
    count: number,
  ) => ({
    key,
    label: key,
    tone,
    items: Array.from({ length: count }, (_, i) => ({
      id: `${key}-${i}`,
      name: `${key}-${i}`,
      href: "/",
    })),
  });

  it("drops empty rows and sorts the worst first", () => {
    const s = summarize([
      row("updates", "neutral", 3),
      row("empty", "error", 0),
      row("memory", "warning", 1),
      row("down", "error", 1),
    ]);
    expect(s.rows.map((r) => r.key)).toEqual(["down", "memory", "updates"]);
    expect(s.worst).toBe("error");
  });

  // An available update is a fact, not a fault.
  it("counts faults without counting neutral rows", () => {
    const s = summarize([row("updates", "neutral", 40), row("down", "error", 2)]);
    expect(s.faults).toBe(2);
  });

  // Expanding the bar to find one chip is the failure this replaces.
  it("names the subjects when there are few enough to fit", () => {
    const s = summarize([row("down", "error", 1)]);
    expect(s.subjects.map((i) => i.name)).toEqual(["down-0"]);
  });

  it("falls back to counts by kind once past the limit", () => {
    const s = summarize([row("down", "error", 3)]);
    expect(s.subjects).toEqual([]);
    expect(s.kinds).toEqual([{ key: "down", label: "down", tone: "error", count: 3 }]);
  });

  // Neutral rows are listed, so a healthy fleet with updates still opens.
  it("reports no worst tone and no rows when everything is empty", () => {
    const s = summarize([row("empty", "error", 0)]);
    expect(s.rows).toEqual([]);
    expect(s.worst).toBeNull();
    expect(s.faults).toBe(0);
  });
});
