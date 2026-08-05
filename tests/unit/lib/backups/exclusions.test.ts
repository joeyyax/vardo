// The pattern is operator input that reaches a container with the volume
// mounted, so the argv it compiles to is pinned here rather than described.

import { describe, it, expect } from "vitest";

import {
  InvalidExclusionError,
  MAX_EXCLUDED_PATHS,
  assertExcludedPath,
  buildFindExclusionArgv,
  normalizeExcludePattern,
  parseExcludedPaths,
  protectListBody,
} from "@/lib/backups/exclusions";

describe("normalizeExcludePattern", () => {
  it("strips a leading anchor and a trailing slash", () => {
    expect(normalizeExcludePattern("  /config/Cache/  ")).toBe("config/Cache");
    expect(normalizeExcludePattern("./Cache")).toBe("Cache");
    expect(normalizeExcludePattern(".//Cache")).toBe("Cache");
  });

  it("keeps a bare name and a glob intact", () => {
    expect(normalizeExcludePattern("Cache")).toBe("Cache");
    expect(normalizeExcludePattern("*.log")).toBe("*.log");
    expect(normalizeExcludePattern("uploads/**")).toBe("uploads/**");
  });

  it("refuses a pattern that climbs out of the volume root", () => {
    expect(() => normalizeExcludePattern("../etc")).toThrow(InvalidExclusionError);
    expect(() => normalizeExcludePattern("config/../../etc")).toThrow(InvalidExclusionError);
    expect(() => normalizeExcludePattern("/..")).toThrow(InvalidExclusionError);
  });

  it("refuses a pattern that names nothing", () => {
    expect(() => normalizeExcludePattern("")).toThrow(InvalidExclusionError);
    expect(() => normalizeExcludePattern("   ")).toThrow(InvalidExclusionError);
    expect(() => normalizeExcludePattern("/")).toThrow(InvalidExclusionError);
    expect(() => normalizeExcludePattern("./")).toThrow(InvalidExclusionError);
    expect(() => normalizeExcludePattern("config//Cache")).toThrow(InvalidExclusionError);
  });

  it("refuses a newline, which would split one pattern into two", () => {
    expect(() => normalizeExcludePattern("Cache\n/etc")).toThrow(InvalidExclusionError);
    expect(() => normalizeExcludePattern("Cache\tx")).toThrow(InvalidExclusionError);
  });

  it("refuses a pattern longer than the column allows", () => {
    expect(() => normalizeExcludePattern("a".repeat(201))).toThrow(InvalidExclusionError);
  });
});

describe("buildFindExclusionArgv", () => {
  it("returns nothing to do when there are no patterns", () => {
    expect(buildFindExclusionArgv([])).toEqual([]);
  });

  it("matches a slashless pattern as a path segment at any depth", () => {
    expect(buildFindExclusionArgv(["Cache"])).toEqual([
      "-mindepth", "1", "(", "-name", "Cache", ")", "-prune", "-print",
    ]);
  });

  it("anchors a pattern holding a slash to the volume root", () => {
    expect(buildFindExclusionArgv(["config/Cache"])).toEqual([
      "-mindepth", "1", "(", "-path", "./config/Cache", ")", "-prune", "-print",
    ]);
  });

  it("anchors a single-segment pattern the operator anchored themselves", () => {
    expect(buildFindExclusionArgv(["/Cache"])).toEqual([
      "-mindepth", "1", "(", "-name", "Cache", ")", "-prune", "-print",
    ]);
  });

  it("joins several patterns as alternatives", () => {
    expect(buildFindExclusionArgv(["*.log", "config/Cache"])).toEqual([
      "-mindepth", "1", "(",
      "-name", "*.log", "-o", "-path", "./config/Cache",
      ")", "-prune", "-print",
    ]);
  });

  it("collapses patterns that normalize to the same thing", () => {
    expect(buildFindExclusionArgv(["Cache", "./Cache/", "/Cache"])).toEqual([
      "-mindepth", "1", "(", "-name", "Cache", ")", "-prune", "-print",
    ]);
  });

  it("never emits a pattern as anything but a value", () => {
    const argv = buildFindExclusionArgv(["-delete", "config/Cache"]);
    expect(argv[argv.indexOf("-name") + 1]).toBe("-delete");
  });

  it("refuses a traversal before it can reach find", () => {
    expect(() => buildFindExclusionArgv(["../../etc"])).toThrow(InvalidExclusionError);
  });

  it("refuses more patterns than the limit", () => {
    const many = Array.from({ length: 101 }, (_, i) => `dir${i}`);
    expect(() => buildFindExclusionArgv(many)).toThrow(InvalidExclusionError);
  });
});

describe("assertExcludedPath", () => {
  it("accepts what find prints", () => {
    expect(assertExcludedPath("./config/Cache")).toBe("./config/Cache");
    expect(assertExcludedPath("./Cache")).toBe("./Cache");
  });

  it("refuses anything that is not relative to the volume root", () => {
    expect(() => assertExcludedPath("/etc/passwd")).toThrow(InvalidExclusionError);
    expect(() => assertExcludedPath("config/Cache")).toThrow(InvalidExclusionError);
    expect(() => assertExcludedPath("./")).toThrow(InvalidExclusionError);
    expect(() => assertExcludedPath("./../etc")).toThrow(InvalidExclusionError);
    expect(() => assertExcludedPath("./config/../../etc")).toThrow(InvalidExclusionError);
  });
});

describe("parseExcludedPaths", () => {
  it("reads the list find wrote", () => {
    expect(parseExcludedPaths("./Cache\n./config/Cache\n")).toEqual(["./Cache", "./config/Cache"]);
  });

  it("refuses a line that is not a path under the volume root", () => {
    expect(() => parseExcludedPaths("./Cache\n/etc\n")).toThrow(InvalidExclusionError);
  });

  it("refuses a list too long to record in full", () => {
    const lines = Array.from({ length: MAX_EXCLUDED_PATHS + 1 }, (_, i) => `./f${i}`).join("\n");
    expect(() => parseExcludedPaths(lines)).toThrow(InvalidExclusionError);
  });
});

describe("protectListBody", () => {
  it("writes one root-relative path per line", () => {
    expect(protectListBody(["./Cache", "./config/Cache"])).toBe("Cache\nconfig/Cache\n");
  });

  it("is empty when the archive left nothing out", () => {
    expect(protectListBody([])).toBe("");
  });

  it("refuses a recorded path that would write outside the volume", () => {
    expect(() => protectListBody(["./../etc"])).toThrow(InvalidExclusionError);
  });
});
