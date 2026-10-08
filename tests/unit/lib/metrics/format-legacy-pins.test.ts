import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes, formatUptime as formatUptimeSeconds } from "@/lib/metrics/format";
import { formatDuration as appStatusDuration, formatUptime as appStatusUptime } from "@/components/app-status";
import { formatDuration as healthDuration } from "@/lib/ui/service-health";
import { formatDuration as activityDuration } from "@/lib/activity/labels";

describe("pre-merge outputs", () => {
  it("metrics formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GB");
    expect(formatBytes(2 * 1024 ** 5)).toBe("2 PB");
  });

  it("metrics formatUptime (seconds)", () => {
    expect(formatUptimeSeconds(30)).toBe("0m");
    expect(formatUptimeSeconds(125)).toBe("2m");
    expect(formatUptimeSeconds(3700)).toBe("1h 1m");
    expect(formatUptimeSeconds(90000)).toBe("1d 1h 0m");
  });

  it("app-status formatDuration", () => {
    expect(appStatusDuration(400)).toBe("400ms");
    expect(appStatusDuration(1999)).toBe("1s");
    expect(appStatusDuration(59_999)).toBe("59s");
    expect(appStatusDuration(125_000)).toBe("2m 5s");
    expect(appStatusDuration(3_700_000)).toBe("61m 40s");
  });

  it("service-health formatDuration", () => {
    expect(healthDuration(750)).toBe("750ms");
    expect(healthDuration(1500)).toBe("1.5s");
    expect(healthDuration(2000)).toBe("2s");
    expect(healthDuration(125_000)).toBe("125s");
  });

  it("activity formatDuration", () => {
    expect(activityDuration(400)).toBe("400ms");
    expect(activityDuration(1999)).toBe("2s");
    expect(activityDuration(59_600)).toBe("1m 0s");
    expect(activityDuration(125_000)).toBe("2m 5s");
    expect(activityDuration(3_700_000)).toBe("61m 40s");
  });

  describe("app-status formatUptime (since a date)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());
    const ago = (s: number) => new Date(Date.now() - s * 1000);

    it("steps down by unit", () => {
      expect(appStatusUptime(ago(45))).toBe("45s");
      expect(appStatusUptime(ago(125))).toBe("2m 5s");
      expect(appStatusUptime(ago(3700))).toBe("1h 1m");
      expect(appStatusUptime(ago(90000 + 120))).toBe("1d 1h");
    });
  });
});
