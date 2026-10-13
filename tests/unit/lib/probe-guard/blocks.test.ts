import { describe, expect, it } from "vitest";
import { blockPattern, blockProblem, matchBlock, probePathRegexp, type CustomBlock } from "@/lib/probe-guard/blocks";
import { PROBE_RULES } from "@/lib/probe-guard/rules";

const regex = (value: string): CustomBlock => ({ kind: "regex", value });

describe("blockProblem", () => {
  it.each([
    "^/old-admin(?:/|$)",
    "^/(?:a|b)/.*\\.bak$",
    "\\.sql(?:\\.gz)?$",
    "^/files/[^/]+\\.zip$",
    "^/a{1,10}$",
    "^/x\\x41",
    "^/lazy.+?end",
    "^/(?:a{10}){10}$",
  ])("accepts %s", (value) => {
    expect(blockProblem(regex(value))).toBeNull();
  });

  it.each([
    ["lookahead", "^/a(?=b)"],
    ["negative lookahead", "^/a(?!b)"],
    ["lookbehind", "(?<=a)b"],
    ["named group", "^/(?<id>a)"],
    ["inline flag", "(?i)^/a"],
    ["atomic group", "(?>a+)b"],
    ["backreference", "^/(a)\\1"],
    ["named backreference", "^/(?:a)\\k<x>"],
    ["unsupported letter escape", "^/\\Aabc"],
    ["bare \\x", "^/\\x{41}"],
    ["empty class", "^/[]a]"],
    ["empty negated class", "^/[^]a]"],
    ["huge repeat", "^/a{1,1001}$"],
    ["nested repeat counts that multiply past 1000", "^/(?:a{40}){40}$"],
    ["nested repeat", "^/a**"],
    ["unbalanced parenthesis", "^/a)"],
    ["possessive repeat", "^/a++"],
    ["backtick", "^/a`b"],
    ["control character", "^/a\u0001"],
    ["unclosed class", "^/[abc"],
    ["bad pattern", "^/(a"],
    ["empty", ""],
    ["too long", `^/${"a".repeat(500)}`],
  ])("refuses a %s", (_name, value) => {
    expect(blockProblem(regex(value))).not.toBeNull();
  });

  it.each([".*", "^/", "^(?:/|a)", "a?", "(?:)|a"])("refuses %s, which matches the home page", (value) => {
    expect(blockProblem(regex(value))).toBe("That pattern matches the home page");
  });

  it("checks paths for prefix and exact entries", () => {
    expect(blockProblem({ kind: "prefix", value: "/old/" })).toBeNull();
    expect(blockProblem({ kind: "exact", value: "/old.php" })).toBeNull();
    expect(blockProblem({ kind: "prefix", value: "/" })).not.toBeNull();
    expect(blockProblem({ kind: "exact", value: "old" })).not.toBeNull();
    expect(blockProblem({ kind: "prefix", value: "/a b" })).not.toBeNull();
  });
});

describe("blockPattern", () => {
  it("escapes prefix and exact entries so a dot is a dot", () => {
    const re = new RegExp(blockPattern({ kind: "exact", value: "/a.php" }), "i");
    expect(re.test("/a.php")).toBe(true);
    expect(re.test("/aXphp")).toBe(false);
    expect(re.test("/a.php/extra")).toBe(false);
    const prefix = new RegExp(blockPattern({ kind: "prefix", value: "/old+(x)" }), "i");
    expect(prefix.test("/old+(x)/more")).toBe(true);
    expect(prefix.test("/oldd(x)")).toBe(false);
  });

  it("matches case-insensitively and finds the entry that tripped", () => {
    const blocks: CustomBlock[] = [{ kind: "prefix", value: "/Old" }, regex("\\.bak$")];
    expect(matchBlock("/old/page", blocks)).toBe(blocks[0]);
    expect(matchBlock("/x/y.BAK", blocks)).toBe(blocks[1]);
    expect(matchBlock("/fine", blocks)).toBeNull();
  });
});

describe("probePathRegexp", () => {
  it("returns null with nothing to match, since an empty alternation matches every path", () => {
    expect(probePathRegexp([], [])).toBeNull();
  });

  it("joins rules and blocks into one case-insensitive alternation", () => {
    const re = probePathRegexp(PROBE_RULES.slice(0, 1), [{ kind: "exact", value: "/x" }])!;
    expect(re.startsWith("(?i)")).toBe(true);
    const js = new RegExp(re.replace(/^\(\?i\)/, ""), "i");
    expect(js.test("/.env")).toBe(true);
    expect(js.test("/X")).toBe(true);
    expect(js.test("/y")).toBe(false);
  });

  it("keeps a block's own alternation from leaking into its neighbors", () => {
    const re = new RegExp(probePathRegexp([], [regex("^/a|^/b"), { kind: "exact", value: "/c" }])!.replace(/^\(\?i\)/, ""), "i");
    expect([re.test("/a"), re.test("/b"), re.test("/c"), re.test("/d")]).toEqual([true, true, true, false]);
  });
});
