import { describe, it, expect } from "vitest";
import { groupNotable, subjectSummary, type GroupableItem } from "@/lib/away/group";

function item(over: Partial<GroupableItem> & { id: string }): GroupableItem {
  return {
    kind: "app.down-unexplained",
    reason: "unexplained",
    subjectName: over.id,
    detail: "Now missing, no deploy to explain it",
    count: 1,
    ...over,
  };
}

describe("groupNotable", () => {
  it("collapses items whose rendered sentence is identical", () => {
    const groups = groupNotable([item({ id: "agents" }), item({ id: "authentik" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.subjectName)).toEqual(["agents", "authentik"]);
  });

  it("keeps items apart when the detail differs", () => {
    const groups = groupNotable([
      item({ id: "a" }),
      item({ id: "b", detail: "Exited non-zero" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("keeps items apart when the kind or reason differs", () => {
    const groups = groupNotable([
      item({ id: "a" }),
      item({ id: "b", kind: "deploy.failed" }),
      item({ id: "c", reason: "regression" }),
    ]);
    expect(groups).toHaveLength(3);
  });

  it("sums occurrences rather than counting subjects", () => {
    const groups = groupNotable([item({ id: "a", count: 3 }), item({ id: "b", count: 4 })]);
    expect(groups[0].occurrences).toBe(7);
    expect(groups[0].items).toHaveLength(2);
  });

  it("preserves classifier order, which is severity order", () => {
    const groups = groupNotable([
      item({ id: "a", kind: "deploy.failed" }),
      item({ id: "b" }),
      item({ id: "c", kind: "deploy.failed" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["deploy.failed", "app.down-unexplained"]);
  });

  it("leaves a single item as a group of one", () => {
    expect(groupNotable([item({ id: "solo" })])).toHaveLength(1);
  });

  it("handles an empty list", () => {
    expect(groupNotable([])).toEqual([]);
  });
});

describe("subjectSummary", () => {
  it("names one subject plainly", () => {
    expect(subjectSummary(["agents"])).toBe("agents");
  });

  it("joins two rather than truncating them", () => {
    expect(subjectSummary(["agents", "authentik"])).toBe("agents and authentik");
  });

  it("joins three, since truncating one name saves nothing", () => {
    expect(subjectSummary(["a", "b", "c"])).toBe("a, b and c");
  });

  it("truncates past the cutoff", () => {
    expect(subjectSummary(["a", "b", "c", "d"])).toBe("a, b and 2 more");
  });

  it("collapses the fleet-wide case to something readable", () => {
    const names = Array.from({ length: 92 }, (_, i) => `app-${i}`);
    expect(subjectSummary(names)).toBe("app-0, app-1 and 90 more");
  });

  it("returns nothing for no subjects", () => {
    expect(subjectSummary([])).toBe("");
  });
});
