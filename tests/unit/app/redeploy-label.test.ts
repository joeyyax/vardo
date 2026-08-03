import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `compose restart` reuses the containers, so env, Traefik labels and compose
// changes only land on a deploy. The rename off "restart" has been missed twice.

const ROOTS = ["app", "components", "lib/ui"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((root) => sources(join(process.cwd(), root)));

/** Every surface that turns `needsRedeploy` into a label. */
const LABEL_SOURCES = [
  "components/app-status.tsx",
  "components/app-row-card.tsx",
  "lib/ui/app-row.ts",
  "app/(authenticated)/projects/[...slug]/project-detail.tsx",
  "app/(authenticated)/apps/[...slug]/app-detail.tsx",
  "app/(authenticated)/apps/[...slug]/compose-detail.tsx",
];

describe("pending config reads as a deploy, never a restart", () => {
  it("carries no restart-needed wording in any rendered source", () => {
    const offenders = FILES.filter((file) => /restart\s*needed/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it.each(LABEL_SOURCES)("%s labels the state a deploy", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    expect(src).toMatch(/needsRedeploy/);
    expect(src).toMatch(/[Dd]eploy needed/);
  });

  it("keeps the standalone indicator off the word restart", () => {
    const src = readFileSync(join(process.cwd(), "components/app-status.tsx"), "utf8");
    const branch = src.slice(src.indexOf("isRunning && needsRedeploy"), src.indexOf("if (isRunning) {"));
    expect(branch).toMatch(/Deploy needed/);
    expect(branch).not.toMatch(/Restart/);
  });
});
