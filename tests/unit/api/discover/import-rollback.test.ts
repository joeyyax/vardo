import { describe, it, expect } from "vitest";
import { parseContainerEnvVars, getPgErrorCode } from "@/lib/docker/import";

// ---------------------------------------------------------------------------
// parseContainerEnvVars
// ---------------------------------------------------------------------------

describe("parseContainerEnvVars", () => {
  it("parses simple KEY=VALUE entries", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["FOO=bar", "BAZ=qux"]);
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(skippedKeys).toHaveLength(0);
  });

  it("splits on the first = only — values may contain =", () => {
    const { vars } = parseContainerEnvVars(["URL=http://host?a=1&b=2"]);
    expect(vars).toEqual({ URL: "http://host?a=1&b=2" });
  });

  it("skips entries with no = separator", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["NOEQUAL", "GOOD=value"]);
    expect(vars).toEqual({ GOOD: "value" });
    expect(skippedKeys).toHaveLength(0);
  });

  it("skips values containing ${...} and records the key", () => {
    const { vars, skippedKeys } = parseContainerEnvVars([
      "SAFE=literal",
      "UNSAFE=${SOME_VAR}",
    ]);
    expect(vars).toEqual({ SAFE: "literal" });
    expect(skippedKeys).toEqual(["UNSAFE"]);
  });

  it("skips inline interpolation in the middle of a value", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["PREFIX=foo${BAR}baz"]);
    expect(vars).toEqual({});
    expect(skippedKeys).toEqual(["PREFIX"]);
  });

  it("handles empty value (KEY=)", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["EMPTY="]);
    expect(vars).toEqual({ EMPTY: "" });
    expect(skippedKeys).toHaveLength(0);
  });

  it("returns empty results for an empty array", () => {
    const { vars, skippedKeys } = parseContainerEnvVars([]);
    expect(vars).toEqual({});
    expect(skippedKeys).toHaveLength(0);
  });

  it("collects multiple skipped keys", () => {
    const { skippedKeys } = parseContainerEnvVars([
      "A=${X}",
      "B=${Y}",
      "C=safe",
    ]);
    expect(skippedKeys).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// getPgErrorCode
// ---------------------------------------------------------------------------

describe("getPgErrorCode", () => {
  it("returns null for non-Error values", () => {
    expect(getPgErrorCode("string")).toBeNull();
    expect(getPgErrorCode(42)).toBeNull();
    expect(getPgErrorCode(null)).toBeNull();
  });

  it("returns the direct code property when present", () => {
    const err = Object.assign(new Error("test"), { code: "23505" });
    expect(getPgErrorCode(err)).toBe("23505");
  });

  it("returns the cause.code when direct code is absent", () => {
    const err = new Error("wrapper");
    err.cause = { code: "23503" };
    expect(getPgErrorCode(err)).toBe("23503");
  });

  it("returns null when neither code nor cause.code exists", () => {
    expect(getPgErrorCode(new Error("plain"))).toBeNull();
  });
});
