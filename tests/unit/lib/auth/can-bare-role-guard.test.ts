import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
  });
}

// A bare role skips the API token's scopes; pass the membership instead.
describe("server can() calls", () => {
  it("never pass a bare role", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles("app/api"), ...sourceFiles("lib")]) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/\bcan\(\s*([\w.?]*role|"(?:owner|admin|member|viewer)")\s*,/gi)) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
