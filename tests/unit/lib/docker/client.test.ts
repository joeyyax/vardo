import { describe, it, expect } from "vitest";
import { normalizeRestartPolicy, parseDockerHealthcheck } from "@/lib/docker/client";
import { nanosToDuration } from "@/lib/docker/compose";

describe("normalizeRestartPolicy", () => {
  it("returns 'no' when name is empty", () => {
    expect(normalizeRestartPolicy("", 0)).toBe("no");
  });

  it("returns the policy name unchanged for non-on-failure policies", () => {
    expect(normalizeRestartPolicy("always", 0)).toBe("always");
    expect(normalizeRestartPolicy("unless-stopped", 0)).toBe("unless-stopped");
    expect(normalizeRestartPolicy("no", 0)).toBe("no");
  });

  it("returns 'on-failure:N' when name is on-failure and maxRetryCount > 0", () => {
    expect(normalizeRestartPolicy("on-failure", 3)).toBe("on-failure:3");
    expect(normalizeRestartPolicy("on-failure", 1)).toBe("on-failure:1");
  });

  it("returns 'on-failure' without suffix when maxRetryCount is 0", () => {
    expect(normalizeRestartPolicy("on-failure", 0)).toBe("on-failure");
  });
});

describe("parseDockerHealthcheck", () => {
  it("returns null when healthcheck is null", () => {
    expect(parseDockerHealthcheck(null)).toBeNull();
  });

  it("returns null when healthcheck is undefined", () => {
    expect(parseDockerHealthcheck(undefined)).toBeNull();
  });

  it("returns null when Test array is absent", () => {
    expect(parseDockerHealthcheck({})).toBeNull();
  });

  it("returns null when Test[0] is NONE (disabled healthcheck)", () => {
    expect(parseDockerHealthcheck({ Test: ["NONE"] })).toBeNull();
  });

  it("returns parsed healthcheck when Test is a real command", () => {
    const result = parseDockerHealthcheck({
      Test: ["CMD", "curl", "-f", "http://localhost/"],
      Interval: 30_000_000_000,
      Timeout: 10_000_000_000,
      Retries: 3,
      StartPeriod: 5_000_000_000,
    });
    expect(result).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost/"],
      interval: 30_000_000_000,
      timeout: 10_000_000_000,
      retries: 3,
      startPeriod: 5_000_000_000,
    });
  });

  it("fills in zeros for missing timing fields", () => {
    const result = parseDockerHealthcheck({ Test: ["CMD-SHELL", "exit 0"] });
    expect(result).toEqual({ test: ["CMD-SHELL", "exit 0"], interval: 0, timeout: 0, retries: 0, startPeriod: 0 });
  });
});

describe("nanosToDuration", () => {
  it("returns minutes for exact minute values", () => {
    expect(nanosToDuration(60_000_000_000)).toBe("1m");
    expect(nanosToDuration(120_000_000_000)).toBe("2m");
  });

  it("returns seconds for exact second values", () => {
    expect(nanosToDuration(30_000_000_000)).toBe("30s");
    expect(nanosToDuration(1_000_000_000)).toBe("1s");
  });

  it("returns milliseconds for exact millisecond values", () => {
    expect(nanosToDuration(500_000_000)).toBe("500ms");
  });

  it("falls back to rounded seconds for sub-millisecond or fractional values", () => {
    // 1.5s — not an integer number of ms or s, not a whole minute
    expect(nanosToDuration(1_500_000_001)).toBe("2s");
  });
});
