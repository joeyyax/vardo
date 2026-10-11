import { describe, it, expect } from "vitest";
import { resolveRebuild, buildCacheLogLine } from "@/lib/docker/build-key";

describe("resolveRebuild", () => {
  it("maps each setting to a rebuild mode", () => {
    expect(resolveRebuild(undefined, "use")).toBeUndefined();
    expect(resolveRebuild(undefined, "skip-reuse")).toBe("force");
    expect(resolveRebuild(undefined, "never")).toBe("no-cache");
  });

  it("treats a missing setting as Use cache", () => {
    expect(resolveRebuild(undefined, null)).toBeUndefined();
    expect(resolveRebuild(undefined, undefined)).toBeUndefined();
  });

  it("keeps an explicit request over the setting", () => {
    expect(resolveRebuild("force", "never")).toBe("force");
    expect(resolveRebuild("no-cache", "use")).toBe("no-cache");
  });

  it("leaves rollbacks on the earlier build", () => {
    expect(resolveRebuild(undefined, "never", true)).toBeUndefined();
    expect(resolveRebuild("no-cache", "use", true)).toBe("no-cache");
  });
});

describe("buildCacheLogLine", () => {
  it("is silent when nothing is rebuilt", () => {
    expect(buildCacheLogLine(undefined, "use", undefined)).toBeNull();
  });
});
