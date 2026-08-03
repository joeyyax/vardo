import { describe, it, expect } from "vitest";

import {
  compactUptime,
  railClass,
  readingLabel,
  rowSeverity,
  sparkPath,
  sparklineTone,
  statusRank,
  statusWord,
  statusWordTone,
  tagLabels,
} from "@/lib/ui/app-row";
import type { AppCondition } from "@/lib/docker/conditions";
import { formatBytes } from "@/lib/metrics/format";

function condition(severity: AppCondition["severity"]): AppCondition {
  return {
    kind: severity === "critical" ? "crash-looping" : "unhealthy",
    severity,
    since: new Date().toISOString(),
    detail: "detail",
  };
}

describe("rowSeverity", () => {
  it("leaves a healthy app with nothing to say", () => {
    expect(rowSeverity("active", null)).toBe("none");
  });

  it("reads a crashed container as critical", () => {
    expect(rowSeverity("error", null)).toBe("critical");
  });

  it("reads a missing container as a warning", () => {
    expect(rowSeverity("missing", null)).toBe("warning");
  });

  it("does not treat a deliberate stop as a problem", () => {
    expect(rowSeverity("stopped", null)).toBe("none");
  });

  it("takes the worse of status and conditions", () => {
    expect(rowSeverity("missing", [condition("critical")])).toBe("critical");
    expect(rowSeverity("error", [condition("warning")])).toBe("critical");
  });

  it("raises a running app that is crash looping", () => {
    expect(rowSeverity("active", [condition("critical")])).toBe("critical");
  });

  it("treats config drift as a warning, but never downgrades", () => {
    expect(rowSeverity("active", null, true)).toBe("warning");
    expect(rowSeverity("error", null, true)).toBe("critical");
  });
});

describe("railClass", () => {
  it("marks problem rows only", () => {
    expect(railClass("critical")).toBe("bg-status-error");
    expect(railClass("warning")).toBe("bg-status-warning");
    expect(railClass("info")).toBeNull();
    expect(railClass("none")).toBeNull();
  });
});

describe("sparklineTone", () => {
  it("stays neutral while the state is normal", () => {
    expect(sparklineTone("none")).toBe("text-muted-foreground/40");
  });

  it("takes the state hue once the row is abnormal", () => {
    expect(sparklineTone("critical")).toBe("text-status-error");
    expect(sparklineTone("warning")).toBe("text-status-warning");
    expect(sparklineTone("info")).toBe("text-status-info");
  });
});

describe("statusWord", () => {
  it("drops the word on a healthy row -- the dot already says it", () => {
    expect(statusWord("active")).toBeNull();
  });

  it("names every other state", () => {
    expect(statusWord("error")).toBe("crashed");
    expect(statusWord("missing")).toBe("no container");
    expect(statusWord("deploying")).toBe("deploying");
    expect(statusWord("stopped")).toBe("stopped");
  });

  it("stays quiet when the container already states this status", () => {
    expect(statusWord("stopped", "stopped")).toBeNull();
    expect(statusWord("error", "stopped")).toBe("crashed");
  });

  it("returns null for a status it has no word for", () => {
    expect(statusWord("unknown")).toBeNull();
  });

  it("tones the word by state", () => {
    expect(statusWordTone("error")).toBe("text-status-error");
    expect(statusWordTone("stopped")).toBe("text-muted-foreground");
  });
});

describe("statusRank", () => {
  it("sorts problems above healthy rows", () => {
    expect(statusRank("error")).toBeLessThan(statusRank("missing"));
    expect(statusRank("missing")).toBeLessThan(statusRank("active"));
  });

  it("puts an unknown status with the idle ones", () => {
    expect(statusRank("weird")).toBe(statusRank("stopped"));
  });
});

describe("compactUptime", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);

  it("uses one unit so the column stays narrow", () => {
    expect(compactUptime(now - 8000, now)).toBe("8s");
    expect(compactUptime(now - 37 * 60000, now)).toBe("37m");
    expect(compactUptime(now - 4 * 3600000, now)).toBe("4h");
    expect(compactUptime(now - 12 * 86400000, now)).toBe("12d");
  });

  it("rounds down at each boundary", () => {
    expect(compactUptime(now - 59999, now)).toBe("59s");
    expect(compactUptime(now - 60000, now)).toBe("1m");
    expect(compactUptime(now - 86399000, now)).toBe("23h");
  });

  it("refuses a clock that runs backwards", () => {
    expect(compactUptime(now + 5000, now)).toBe("—");
    expect(compactUptime("nonsense", now)).toBe("—");
  });
});

describe("sparkPath", () => {
  it("needs two points to draw a line", () => {
    expect(sparkPath([])).toBeNull();
    expect(sparkPath([5])).toBeNull();
  });

  it("spans the full width and ends on the last point", () => {
    const path = sparkPath([0, 5, 10]);
    expect(path?.d).toBe("M0,16L32,9L64,2");
    expect(path?.end).toEqual([64, 2]);
  });

  it("centers a flat series instead of pinning it to an edge", () => {
    const path = sparkPath([3, 3, 3]);
    expect(path?.d).toBe("M0,9L32,9L64,9");
  });

  it("ignores readings that are not numbers", () => {
    expect(sparkPath([1, NaN, 2])?.d).toBe("M0,16L64,2");
  });
});

describe("readingLabel", () => {
  it("reads an absent measurement as n/a, never as zero bytes", () => {
    expect(readingLabel(null, formatBytes)).toBe("n/a");
    expect(readingLabel(undefined, formatBytes)).toBe("n/a");
  });

  it("keeps a measured zero as a measurement", () => {
    expect(readingLabel(0, formatBytes)).toBe("0 B");
  });

  it("formats anything else through the given formatter", () => {
    expect(readingLabel(1024, formatBytes)).toBe("1 KB");
  });
});

describe("tagLabels", () => {
  it("lowercases and trims", () => {
    expect(tagLabels([" Media ", "AI"]).shown).toEqual(["media", "ai"]);
  });

  it("counts what does not fit", () => {
    const { shown, overflow } = tagLabels(["a", "b", "c", "d"]);
    expect(shown).toEqual(["a", "b"]);
    expect(overflow).toBe(2);
  });

  it("drops empties rather than rendering a gap", () => {
    expect(tagLabels(["", "  ", "ok"])).toEqual({ shown: ["ok"], overflow: 0 });
  });
});
