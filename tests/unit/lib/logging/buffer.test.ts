import { describe, it, expect } from "vitest";
import { capLines, mergeOlder, historyUrlFor } from "@/lib/logging/buffer";

const line = (text: string) => ({ text });

describe("capLines", () => {
  it("drops the oldest lines past the limit", () => {
    expect(capLines([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });

  it("leaves a short buffer alone", () => {
    const lines = [1, 2];
    expect(capLines(lines, 5)).toBe(lines);
  });
});

describe("mergeOlder", () => {
  it("drops the overlap between the page and the buffer", () => {
    const older = ["a", "b", "c", "d", "e", "f", "g"].map(line);
    const existing = ["c", "d", "e", "f", "g"].map(line);
    expect(mergeOlder(older, existing).map((l) => l.text)).toEqual(
      ["a", "b", "c", "d", "e", "f", "g"]
    );
  });

  it("keeps everything when the pages do not overlap", () => {
    expect(mergeOlder(["a", "b"].map(line), ["y", "z"].map(line)).map((l) => l.text))
      .toEqual(["a", "b", "y", "z"]);
  });

  it("returns the buffer unchanged when the page adds nothing", () => {
    const existing = ["a", "b", "c", "d", "e"].map(line);
    expect(mergeOlder(existing, existing)).toHaveLength(existing.length);
  });

  it("handles an empty side", () => {
    expect(mergeOlder([], [line("a")]).map((l) => l.text)).toEqual(["a"]);
    expect(mergeOlder([line("a")], []).map((l) => l.text)).toEqual(["a"]);
  });
});

describe("historyUrlFor", () => {
  it("drops the stream segment and keeps the scoping params", () => {
    expect(historyUrlFor("/api/v1/organizations/o/apps/a/logs/stream?environment=production", { tail: "700" }))
      .toBe("/api/v1/organizations/o/apps/a/logs?environment=production&tail=700");
  });

  it("carries the all-services flag over", () => {
    expect(historyUrlFor("/logs/stream?services=all"))
      .toBe("/logs?services=all");
  });
});
