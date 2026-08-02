import { describe, it, expect } from "vitest";
import {
  findRanges,
  findMatches,
  stepMatch,
  matchedLines,
  filterToMatches,
} from "@/lib/logging/search";

describe("findRanges", () => {
  it("finds every occurrence, ignoring case", () => {
    expect(findRanges("Req abc Req ABC", "req")).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it("does not overlap repeated matches", () => {
    expect(findRanges("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(findRanges("anything", "")).toEqual([]);
  });
});

describe("findMatches", () => {
  const lines = [
    "GET /a req=abc",
    "nothing here",
    "req=abc again req=abc",
  ];

  it("numbers matches within their own line", () => {
    expect(findMatches(lines, "req")).toEqual([
      { line: 0, ordinal: 0, start: 7, end: 10 },
      { line: 2, ordinal: 0, start: 0, end: 3 },
      { line: 2, ordinal: 1, start: 14, end: 17 },
    ]);
  });

  it("returns nothing without a query", () => {
    expect(findMatches(lines, "")).toEqual([]);
  });
});

describe("stepMatch", () => {
  it("wraps forwards and backwards", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
  });

  it("starts at the first match going forwards and the last going back", () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
  });

  it("has nowhere to go with no matches", () => {
    expect(stepMatch(-1, 0, 1)).toBe(-1);
  });
});

describe("filterToMatches", () => {
  it("keeps only lines that matched", () => {
    const lines = ["a req", "b", "c req"];
    const matched = matchedLines(findMatches(lines, "req"));
    expect(matched).toEqual(new Set([0, 2]));
    expect(filterToMatches(lines, matched)).toEqual(["a req", "c req"]);
  });
});
