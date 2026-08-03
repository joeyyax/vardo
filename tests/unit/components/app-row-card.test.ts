import { describe, it, expect } from "vitest";

import { memoryLimitLabel } from "@/components/app-row-card";

describe("memoryLimitLabel", () => {
  it("reads null as unknown -- never observed", () => {
    expect(memoryLimitLabel(null)).toBe("Unknown");
  });

  it("reads 0 as genuinely uncapped, not unknown", () => {
    expect(memoryLimitLabel(0)).toBe("No limit");
  });

  it("null and 0 must not produce the same label", () => {
    expect(memoryLimitLabel(null)).not.toBe(memoryLimitLabel(0));
  });

  it("formats a positive limit", () => {
    expect(memoryLimitLabel(512 * 1024 * 1024)).toBe("512 MB limit");
  });
});
