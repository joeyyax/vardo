import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("chevron usage", () => {
  it("expands in place with DisclosureChevron, not a flipped ChevronDown", () => {
    const flipped = /Chevron(Down|Up)\b[^>]*(rotate-180|group-open|group-data-\[state=open\])/;
    const offenders = ["app", "components"]
      .flatMap(sources)
      .filter((file) => flipped.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
