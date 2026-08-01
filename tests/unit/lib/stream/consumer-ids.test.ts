import { describe, it, expect } from "vitest";
import { isValidStreamId } from "@/lib/stream/consumer";

describe("isValidStreamId", () => {
  it("accepts a real entry id", () => {
    expect(isValidStreamId("1750000000000-0")).toBe(true);
  });

  it("accepts the beginning and tail specials", () => {
    expect(isValidStreamId("0")).toBe(true);
    expect(isValidStreamId("0-0")).toBe(true);
    expect(isValidStreamId("$")).toBe(true);
  });

  it("rejects a corrupt persisted cursor", () => {
    expect(isValidStreamId("undefined")).toBe(false);
    expect(isValidStreamId("1750000000000")).toBe(false);
    expect(isValidStreamId("")).toBe(false);
    expect(isValidStreamId(null)).toBe(false);
  });
});
