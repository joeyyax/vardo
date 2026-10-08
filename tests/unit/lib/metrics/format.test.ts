import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatUptime } from "@/lib/metrics/format";

describe("formatDuration", () => {
  it("renders milliseconds under a second", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(750)).toBe("750ms");
  });

  it("rounds whole seconds under a minute", () => {
    expect(formatDuration(1999)).toBe("2s");
    expect(formatDuration(4200)).toBe("4s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  it("rolls 59.6s over to a minute", () => {
    expect(formatDuration(59_600)).toBe("1m 0s");
  });

  it("renders minutes and seconds, then hours and minutes", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_700_000)).toBe("1h 2m");
    expect(formatDuration(7_200_000)).toBe("2h 0m");
  });

  it("keeps one decimal under a minute when precise", () => {
    expect(formatDuration(1500, { precise: true })).toBe("1.5s");
    expect(formatDuration(2000, { precise: true })).toBe("2s");
    expect(formatDuration(750, { precise: true })).toBe("750ms");
    expect(formatDuration(125_000, { precise: true })).toBe("2m 5s");
  });
});

describe("formatUptime", () => {
  it("steps down by unit", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(125)).toBe("2m 5s");
    expect(formatUptime(3700)).toBe("1h 1m");
    expect(formatUptime(90_120)).toBe("1d 1h 2m");
  });

  it("treats negative input as zero", () => {
    expect(formatUptime(-5)).toBe("0s");
  });
});

describe("formatBytes", () => {
  it("scales and trims trailing zeros", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
  });
});
