import { describe, it, expect } from "vitest";

import { errorRateRows } from "@/lib/attention/error-rate-rows";

const APPS = [
  { id: "a1", name: "shop", displayName: "Shop" },
  { id: "a2", name: "api", displayName: "API" },
];

describe("errorRateRows", () => {
  it("returns nothing when no app has stepped up", () => {
    expect(errorRateRows(APPS, [])).toEqual([]);
  });

  it("is a warning, not an error — the app is up, only noisier", () => {
    const [row] = errorRateRows(APPS, [{ appId: "a1", recent: 84, baseline: 6 }]);
    expect(row.tone).toBe("warning");
    expect(row.key).toBe("error-rate");
  });

  it("names the numbers and links to the app's errors tab", () => {
    const [row] = errorRateRows(APPS, [{ appId: "a1", recent: 84, baseline: 6 }]);
    expect(row.items[0]).toMatchObject({
      name: "Shop",
      href: "/apps/shop/errors",
      detail: "84 in 30 min · usually 6",
    });
  });

  it("drops an app the caller did not list, rather than inventing a subject", () => {
    const rows = errorRateRows(APPS, [{ appId: "gone", recent: 84, baseline: 6 }]);
    expect(rows).toEqual([]);
  });

  it("collects every elevated app into one row", () => {
    const [row] = errorRateRows(APPS, [
      { appId: "a1", recent: 84, baseline: 6 },
      { appId: "a2", recent: 40, baseline: 2 },
    ]);
    expect(row.items).toHaveLength(2);
  });
});
