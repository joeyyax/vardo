import { describe, it, expect } from "vitest";
import { countApps, describeScopeCounts } from "@/lib/metrics/scope";

const apps = [
  { status: "active", parentAppId: null },
  { status: "active", parentAppId: "parent-1" },
  { status: "missing", parentAppId: "parent-1" },
  { status: "stopped", parentAppId: null },
  { status: "error", parentAppId: null },
  { status: "deploying", parentAppId: null },
  { status: "orphaned", parentAppId: null },
];

describe("countApps", () => {
  it("splits a record count into top-level apps and compose services", () => {
    const counts = countApps(apps);
    expect(counts.total).toBe(7);
    expect(counts.topLevel).toBe(5);
    expect(counts.composeServices).toBe(2);
  });

  it("counts every known status and ignores unknown ones", () => {
    expect(countApps(apps).byStatus).toEqual({
      active: 2,
      stopped: 1,
      error: 1,
      deploying: 1,
      missing: 1,
    });
  });

  it("treats a missing parentAppId field as top-level", () => {
    expect(countApps([{ status: "active" }]).topLevel).toBe(1);
  });

  it("returns zeroes for an empty scope", () => {
    const counts = countApps([]);
    expect(counts).toMatchObject({ total: 0, topLevel: 0, composeServices: 0 });
  });
});

describe("describeScopeCounts", () => {
  it("names both parts when compose services exist", () => {
    expect(describeScopeCounts(countApps(apps))).toBe("5 apps · 2 compose services");
  });

  it("omits compose services when there are none", () => {
    expect(describeScopeCounts(countApps([{ status: "active", parentAppId: null }]))).toBe("1 app");
  });
});
