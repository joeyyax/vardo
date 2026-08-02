import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatLatency,
  serviceDotColor,
  serviceStatusTone,
  serviceStatusWord,
} from "@/lib/ui/service-health";

describe("service dot state", () => {
  it("colors the dot by status", () => {
    expect(serviceDotColor("healthy")).toBe("bg-status-success");
    expect(serviceDotColor("unhealthy")).toBe("bg-status-error");
    expect(serviceDotColor("unconfigured")).toBe("bg-status-neutral");
  });

  it("tones the status word to match the dot", () => {
    expect(serviceStatusTone("healthy")).toBe("text-status-success");
    expect(serviceStatusTone("unhealthy")).toBe("text-status-error");
    expect(serviceStatusTone("unconfigured")).toBe("text-muted-foreground");
  });

  it("names each status", () => {
    expect(serviceStatusWord("healthy")).toBe("Healthy");
    expect(serviceStatusWord("unhealthy")).toBe("Unhealthy");
    expect(serviceStatusWord("unconfigured")).toBe("Not configured");
  });
});

describe("formatDuration", () => {
  it("reads a probe budget in seconds", () => {
    expect(formatDuration(2000)).toBe("2s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("stays in milliseconds below a second", () => {
    expect(formatDuration(750)).toBe("750ms");
  });
});

describe("formatLatency", () => {
  it("shows a dash when the probe never reported one", () => {
    expect(formatLatency(undefined)).toBe("—");
  });

  it("shows milliseconds", () => {
    expect(formatLatency(0)).toBe("0 ms");
    expect(formatLatency(184)).toBe("184 ms");
  });
});
