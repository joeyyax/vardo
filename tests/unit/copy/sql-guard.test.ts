import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROOTS = ["lib", "app"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// Copy passes rewrite "is not" to "isn't"; inside SQL that's a syntax error.
describe("sql templates", () => {
  it("contain no contractions", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sourceFiles)) {
      for (const m of readFileSync(file, "utf8").matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)) {
        if (/\b\w+n't\b/.test(m[1])) offenders.push(`${file}: ${m[1].trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
