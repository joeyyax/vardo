import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// The production image copies next.config.ts on its own, without the source tree.
describe("next.config.ts", () => {
  it("imports only packages, never local files", () => {
    const source = readFileSync("next.config.ts", "utf8");
    const local = [...source.matchAll(/from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g)].map((m) => m[1]);
    expect(local).toEqual([]);
  });
});
