import { describe, it, expect, vi } from "vitest";
import { percentages, sparkline, visualText } from "@/lib/email/templates/components";
import { backupColumns, backupDrop } from "@/lib/email/templates/visuals";
import { phaseVisual } from "@/lib/email/templates/deploy-facts";
import { hourlyDeltas, loadMailSeries } from "@/lib/email/series";
import { deployDays } from "@/lib/digest/collector";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail } from "@/lib/email/notification-email";
import { notificationSubject } from "@/lib/email/subjects";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/metrics/store-disk", () => ({ queryDiskHistory: () => Promise.reject(new Error("redis down")) }));
vi.mock("@/lib/metrics/store-container", () => ({ queryDiskWriteRange: () => new Promise(() => {}) }));

const t = (ms: number) => ({ startedAt: "", endedAt: "", ms });

describe("chart math", () => {
  it("rounds segments to whole percents that add to 100", () => {
    const pct = percentages([3200, 61800, 4100, 6300, 12400, 2100]);
    expect(pct.reduce((a, b) => a + b, 0)).toBe(100);
    expect(percentages([1, 1000])).toEqual([1, 99]);
    expect(percentages([0, 0])).toEqual([0, 0]);
  });

  it("draws a sparkline from zero", () => {
    expect(sparkline([0, 4, 8])).toBe("▁▅█");
    expect(sparkline([5, 5])).toBe("██");
  });
});

describe("phase bar", () => {
  it("ends a failed deploy's bar at the failing phase, in red", () => {
    const visual = phaseVisual({ clone: t(3000), build: t(40000), pull: t(2000), up: t(1000), healthWait: t(60000) }, "build")!;
    expect(visual.kind).toBe("stacked");
    if (visual.kind !== "stacked") return;
    expect(visual.segments.map((s) => s.label)).toEqual(["Clone", "Build"]);
    expect(visual.segments.at(-1)?.tone).toBe("fail");
    expect(visualText(visual)).toContain("Clone 7% · Build 93% ✗");
  });

  it("skips a single untimed phase on success", () => {
    expect(phaseVisual({ build: t(1000) })).toBeUndefined();
    expect(phaseVisual(undefined)).toBeUndefined();
  });
});

describe("backup size history", () => {
  const history = [1800, 1840, 1860, 1880, 1900, 1918];

  it("flags a drop of more than 30% below the median", () => {
    expect(backupDrop(history, 100)).toMatchObject({ median: 1870 });
    expect(backupDrop(history, 1500)).toBeNull();
    expect(backupDrop([1800, 1900], 10)).toBeNull();
  });

  it("marks the shrunken run and adds a warning fact", () => {
    const chart = backupColumns("shop-mysql", history, 100)!;
    expect(chart.warning?.label).toBe("Smaller than usual");
    if (chart.visual.kind !== "columns") throw new Error("columns");
    expect(chart.visual.columns.at(-1)?.parts[0].tone).toBe("warn");
  });

  it("warns in the subject and body", async () => {
    const fixture = EMAIL_FIXTURES.find((f) => f.name === "backup-success-drop")!;
    const ctx = { ...FIXTURE_CONTEXT, series: fixture.series };
    expect(notificationSubject(fixture.event, ctx)).toBe("⚠ Backup Nightly · shop-mysql much smaller than usual");
    const email = (await renderNotificationEmail(fixture.event, ctx))!;
    expect(email.text).toContain("Smaller than usual: shop-mysql is 94% below its usual");
    expect(email.text).toContain("shop-mysql, last 7 runs (older → this run · 100 MiB)\n██████▁");
  });

  it("leaves the chart out without history", async () => {
    const fixture = EMAIL_FIXTURES.find((f) => f.name === "backup-success")!;
    const email = (await renderNotificationEmail(fixture.event, FIXTURE_CONTEXT))!;
    expect(email.text).not.toContain("last 7 runs");
    expect(email.subject).toBe("✓ Backup Nightly · 2.3 GiB");
  });
});

describe("loadMailSeries", () => {
  it("drops a chart whose query fails or hangs", async () => {
    const disk = EMAIL_FIXTURES.find((f) => f.name === "system-disk-alert")!.event;
    expect(await loadMailSeries(disk)).toEqual({ dockerDisk24h: undefined });
    const writes = EMAIL_FIXTURES.find((f) => f.name === "disk-write-alert")!.event;
    const started = Date.now();
    expect(await loadMailSeries(writes)).toEqual({ diskWritesHourly: undefined });
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe("series helpers", () => {
  it("turns a cumulative counter into per-hour writes", () => {
    const now = 24 * 3_600_000;
    const points: [number, number][] = [
      [now - 2 * 3_600_000 + 1, 100],
      [now - 2 * 3_600_000 + 1_800_000, 400],
      [now - 3_600_000 + 1, 400],
      [now - 1, 1400],
    ];
    const deltas = hourlyDeltas(points, now);
    expect(deltas).toHaveLength(24);
    expect(deltas.slice(-2)).toEqual([300, 1000]);
  });

  it("buckets deploys by UTC day", () => {
    const now = new Date("2026-10-09T17:00:00Z");
    const days = deployDays(
      [
        { status: "success", startedAt: new Date("2026-10-09T01:00:00Z") },
        { status: "failed", startedAt: new Date("2026-10-07T12:00:00Z") },
        { status: "success", startedAt: new Date("2026-09-01T12:00:00Z") },
      ],
      now,
    );
    expect(days).toHaveLength(7);
    expect(days[0].day).toBe("2026-10-03");
    expect(days[6]).toEqual({ day: "2026-10-09", succeeded: 1, failed: 0 });
    expect(days[4]).toEqual({ day: "2026-10-07", succeeded: 0, failed: 1 });
  });
});
