import { describe, it, expect } from "vitest";
import { normalizePathPrefix, pathRoutePriority } from "@/lib/domains/path-prefix";

describe("normalizePathPrefix", () => {
  it("normalizes", () => {
    expect(normalizePathPrefix("/docs")).toBe("/docs");
    expect(normalizePathPrefix("docs/")).toBe("/docs");
    expect(normalizePathPrefix(" /event-space-docs/ ")).toBe("/event-space-docs");
    expect(normalizePathPrefix("/a/b.c_d~e")).toBe("/a/b.c_d~e");
  });

  it("treats empty and / as the whole host", () => {
    for (const v of ["", "/", "//", null, undefined]) expect(normalizePathPrefix(v)).toBeNull();
  });

  it("refuses anything outside unreserved characters and dot segments", () => {
    for (const v of ["/a b", "/a`b", "/a)b", "/a?b", "/a%20", "/a//b", "/..", "/a/./b", `/${"x".repeat(200)}`]) {
      expect(normalizePathPrefix(v)).toBeUndefined();
    }
  });
});

describe("pathRoutePriority", () => {
  it("ranks a longer prefix above a shorter one", () => {
    expect(pathRoutePriority("/docs/api")).toBeGreaterThan(pathRoutePriority("/docs"));
  });
});
