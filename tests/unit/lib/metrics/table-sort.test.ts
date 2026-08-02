import { describe, it, expect } from "vitest";
import {
  DEFAULT_SORT,
  nextSortDirection,
  sortAppRows,
  type SortableAppRow,
} from "@/lib/metrics/table-sort";

function row(name: string, over: Partial<SortableAppRow> = {}): SortableAppRow {
  return { name, cpu: 0, memory: 0, network: 0, limit: 0, containers: 0, ...over };
}

const rows = [
  row("beta", { cpu: 12.5, memory: 900, containers: 2 }),
  row("alpha", { cpu: 41, memory: 100, containers: 1 }),
  row("gamma", { cpu: 12.5, memory: 500, containers: 5 }),
];

describe("sortAppRows", () => {
  it("defaults to CPU descending", () => {
    const sorted = sortAppRows(rows, DEFAULT_SORT.key, DEFAULT_SORT.direction);
    expect(sorted.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("breaks numeric ties by name ascending", () => {
    const sorted = sortAppRows(rows, "cpu", "asc");
    expect(sorted.map((r) => r.name)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("sorts by name", () => {
    expect(sortAppRows(rows, "name", "desc").map((r) => r.name)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("sorts other numeric columns", () => {
    expect(sortAppRows(rows, "containers", "desc").map((r) => r.name)).toEqual(["gamma", "beta", "alpha"]);
    expect(sortAppRows(rows, "memory", "desc").map((r) => r.name)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("does not mutate the input", () => {
    const input = [...rows];
    sortAppRows(input, "memory", "asc");
    expect(input).toEqual(rows);
  });
});

describe("nextSortDirection", () => {
  it("flips the active column", () => {
    expect(nextSortDirection({ key: "cpu", direction: "desc" }, "cpu")).toBe("asc");
    expect(nextSortDirection({ key: "cpu", direction: "asc" }, "cpu")).toBe("desc");
  });

  it("starts a new numeric column descending and a name column ascending", () => {
    expect(nextSortDirection({ key: "cpu", direction: "asc" }, "memory")).toBe("desc");
    expect(nextSortDirection({ key: "cpu", direction: "asc" }, "name")).toBe("asc");
  });
});
