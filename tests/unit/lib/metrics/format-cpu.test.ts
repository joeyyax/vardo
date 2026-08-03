import { describe, expect, it } from "vitest";
import { cpuDisplay, formatCores, formatCoresShort } from "@/lib/metrics/format";

// cAdvisor percent: 100 is one core saturated.
const HOST = { kind: "capacity", cores: 32 } as const;

describe("formatCores", () => {
  it("converts per-core percent to cores", () => {
    expect(formatCores(59.6)).toBe("0.60 cores");
    expect(formatCores(118.03)).toBe("1.18 cores");
  });

  it("never caps the absolute figure", () => {
    expect(formatCores(3100)).toBe("31.0 cores");
    expect(formatCores(12800)).toBe("128 cores");
  });

  it("renders absent as absent rather than zero", () => {
    expect(formatCores(null)).toBe("—");
    expect(formatCores(undefined)).toBe("—");
    expect(formatCores(0)).toBe("0.00 cores");
  });

  it("keeps a tiny reading visible instead of rounding it away", () => {
    expect(formatCores(0.4)).toBe("<0.01 cores");
  });

  it("drops the unit for a chart axis", () => {
    expect(formatCoresShort(59.6)).toBe("0.6");
    expect(formatCoresShort(3200)).toBe("32");
  });
});

describe("cpuDisplay against host capacity", () => {
  it("normalizes the headline and states the absolute below it", () => {
    const cpu = cpuDisplay(59.6, HOST);
    expect(cpu.headline).toBe("1.9%");
    expect(cpu.detail).toBe("0.60 of 32 cores");
    expect(cpu.compact).toBe("0.60 cores · 1.9% of host");
  });

  it("rounds the share to whole percent once it is big enough to matter", () => {
    expect(cpuDisplay(1600, HOST).headline).toBe("50%");
  });

  it("never exceeds 100% on the normalized figure", () => {
    const cpu = cpuDisplay(4000, HOST);
    expect(cpu.share).toBe(100);
    expect(cpu.headline).toBe("100%");
    expect(cpu.meter).toBe(1);
    // The overshoot survives in the core figure, which is the point.
    expect(cpu.compact).toBe("40.0 cores · 100% of host");
  });

  it("reports a nonzero reading as nonzero", () => {
    expect(cpuDisplay(0.5, HOST).headline).toBe("<0.1%");
    expect(cpuDisplay(0, HOST).headline).toBe("0%");
  });
});

describe("cpuDisplay against an enforced limit", () => {
  it("measures the app against its own cap", () => {
    const cpu = cpuDisplay(118.03, { kind: "enforced", cores: 2 });
    expect(cpu.headline).toBe("59%");
    expect(cpu.detail).toBe("1.18 of 2 cores");
    expect(cpu.compact).toBe("1.18 / 2 cores (59%)");
    expect(cpu.meter).toBeCloseTo(0.59, 2);
  });

  it("keeps a fractional cap readable", () => {
    expect(cpuDisplay(25, { kind: "enforced", cores: 0.5 }).compact).toBe("0.25 / 0.5 cores (50%)");
  });
});

describe("cpuDisplay with no ceiling", () => {
  it("falls back to the absolute, with no share to state", () => {
    const cpu = cpuDisplay(118.03);
    expect(cpu.headline).toBe("1.18 cores");
    expect(cpu.detail).toBeNull();
    expect(cpu.share).toBeNull();
    expect(cpu.meter).toBeNull();
  });

  it("treats an unknown core count as no ceiling", () => {
    expect(cpuDisplay(118.03, { kind: "capacity", cores: 0 }).headline).toBe("1.18 cores");
  });

  it("renders absent as absent rather than zero", () => {
    const cpu = cpuDisplay(null, HOST);
    expect(cpu.headline).toBe("—");
    expect(cpu.compact).toBe("—");
    expect(cpu.cores).toBeNull();
    expect(cpu.share).toBeNull();
    expect(cpu.meter).toBeNull();
  });
});
