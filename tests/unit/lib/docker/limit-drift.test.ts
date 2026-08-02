import { describe, it, expect } from "vitest";

import { memoryLimitDrifted } from "@/lib/docker/limit-drift";

const MB = 1024 * 1024;

describe("memoryLimitDrifted", () => {
  // The case from production: 256 MB configured, container running unlimited.
  it("detects a configured limit the container does not have", () => {
    expect(memoryLimitDrifted(256, 0)).toBe(true);
  });

  it("matches when the container carries the configured limit", () => {
    expect(memoryLimitDrifted(256, 256 * MB)).toBe(false);
    expect(memoryLimitDrifted(1024, 1024 * MB)).toBe(false);
  });

  it("tolerates rounding", () => {
    expect(memoryLimitDrifted(256, 256 * MB + 512)).toBe(false);
    expect(memoryLimitDrifted(256, 256 * MB - 1024)).toBe(false);
  });

  it("flags a container running a different limit than configured", () => {
    expect(memoryLimitDrifted(256, 512 * MB)).toBe(true);
  });

  // No configured limit means the tier default applies, which is not drift.
  it("ignores apps with nothing configured", () => {
    expect(memoryLimitDrifted(null, 0)).toBe(false);
    expect(memoryLimitDrifted(undefined, 512 * MB)).toBe(false);
    expect(memoryLimitDrifted(0, 512 * MB)).toBe(false);
  });

  it("ignores an app with no observation", () => {
    expect(memoryLimitDrifted(256, null)).toBe(false);
    expect(memoryLimitDrifted(256, undefined)).toBe(false);
  });
});
