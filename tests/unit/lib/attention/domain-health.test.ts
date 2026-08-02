import { describe, it, expect } from "vitest";

import { isConfirmedUnreachable } from "@/lib/attention/domain-health";

const down = { reachable: false };
const up = { reachable: true };

describe("isConfirmedUnreachable", () => {
  it("confirms a domain that failed the last two checks", () => {
    expect(isConfirmedUnreachable([down, down])).toBe(true);
  });

  // The case from production: one aborted request between two good ones.
  it("ignores a single failure with a success behind it", () => {
    expect(isConfirmedUnreachable([down, up])).toBe(false);
  });

  it("clears once the latest check succeeds", () => {
    expect(isConfirmedUnreachable([up, down])).toBe(false);
    expect(isConfirmedUnreachable([up, up])).toBe(false);
  });

  // A first-ever check that fails should not raise an alarm on its own.
  it("does not confirm from a single check", () => {
    expect(isConfirmedUnreachable([down])).toBe(false);
    expect(isConfirmedUnreachable([])).toBe(false);
  });

  it("reads only the two most recent when given more", () => {
    expect(isConfirmedUnreachable([down, down, up, up])).toBe(true);
    expect(isConfirmedUnreachable([down, up, down, down])).toBe(false);
  });

  it("treats a null reading as not-a-failure", () => {
    expect(isConfirmedUnreachable([{ reachable: null }, down])).toBe(false);
  });
});
