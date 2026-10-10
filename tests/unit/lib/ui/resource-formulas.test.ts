import { describe, it, expect } from "vitest";
import { describeDefaults } from "@/lib/resources/defaults";
import { learnedStatus } from "@/lib/resources/learned";
import { FORMULA_ROWS, formatMb, formulaTable, hostSummary, learnedSummary } from "@/lib/ui/resource-formulas";

const GiB = 1024 ** 3;
const MIB = 1024 * 1024;
const host = { cpus: 8, memoryBytes: Math.round(15.6 * GiB) };
const rules = describeDefaults(host, 8, {});

describe("Resources settings", () => {
  it("states each formula in plain language", () => {
    expect(FORMULA_ROWS.map((r) => [r.label, r.formula])).toEqual([
      ["Critical", "RAM ÷ 8, between 1 GB (2 GB from 6 GB of RAM) and 8 GB"],
      ["Standard", "RAM ÷ 16, between 1 GB and 4 GB"],
      ["Disposable", "Half of standard, at least 512 MB"],
      ["Deploys at once", "One per 2 cores or per 4 GB of RAM, whichever is fewer, from 1 to 6"],
      ["Redis", "RAM ÷ 32, between 512 MB and 2 GB"],
    ]);
  });

  it("sums up this server", () => {
    expect(hostSummary(host, rules)).toBe(
      "On this server (15.6 GB, 8 cores): critical 2 GB, standard 1 GB, disposable 512 MB, 4 deploys at once, Redis 512 MB.",
    );
    expect(hostSummary(null, rules)).toBeNull();
  });

  it("shows the rule, not an admin value", () => {
    const withAdmin = describeDefaults(host, 8, {}, undefined, { memoryStandard: 3072 });
    expect(formulaTable(withAdmin).find((r) => r.key === "memoryStandard")!.here).toBe("1 GB");
  });

  it("formats MB and GB", () => {
    expect(formatMb(512)).toBe("512 MB");
    expect(formatMb(1024)).toBe("1 GB");
    expect(formatMb(1984)).toBe("1.9 GB");
  });
});

describe("app Resources tab", () => {
  const NOW = Date.UTC(2026, 9, 20, 12);
  const days = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ day: new Date(NOW - (i + 1) * 86_400_000).toISOString().slice(0, 10), bytes: 410 * MIB, p99: 400 * MIB }));

  it("shows progress while learning", () => {
    expect(learnedSummary(learnedStatus(days(3), 1024, NOW), { explicit: false, runningMb: 1024 })).toBe(
      "Learning from use: 3 of 7 days recorded. The tier default applies until then.",
    );
  });

  it("shows the learned default and when it applies", () => {
    const status = learnedStatus(days(9), 1024, NOW);
    expect(learnedSummary(status, { explicit: false, runningMb: 1024 })).toBe(
      "Learned default 576 MB. Learned from 9 days: p99 400 MB, peak 410 MB. Applies on the next deploy.",
    );
    expect(learnedSummary(status, { explicit: false, runningMb: 576 })).not.toMatch(/next deploy/);
  });

  it("says an explicit limit wins", () => {
    expect(learnedSummary(learnedStatus(days(9), 1024, NOW), { explicit: true, runningMb: 2048 })).toBe(
      "The limit set here wins over the learned default of 576 MB.",
    );
  });
});
