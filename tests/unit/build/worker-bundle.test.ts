import { readFileSync } from "fs";
import { builtinModules } from "module";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildWorker, forbiddenImports } from "../../../scripts/build-worker.mjs";

// The worker bundle must never reach Next's runtime, and every package it leaves external must be in the runner image.

type Metafile = { inputs: Record<string, { imports: { path: string; external?: boolean }[] }> };

const root = join(__dirname, "../../..");
const pkgName = (s: string) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);

describe("worker bundle", () => {
  let metafile: Metafile;

  it("builds from worker/index.ts", async () => {
    metafile = (await buildWorker({ outfile: join(root, "dist/worker-test.mjs"), write: false })) as Metafile;
    expect(Object.keys(metafile.inputs)).toContain("worker/index.ts");
    expect(Object.keys(metafile.inputs)).toContain("lib/worker/registry.ts");
  }, 60_000);

  it("imports nothing from next/*", () => {
    expect(forbiddenImports(metafile)).toEqual([]);
  });

  it("leaves external only packages in dependencies, which the runner image installs", () => {
    const deps = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies));
    const builtins = new Set(builtinModules);
    const external = new Set<string>();
    for (const info of Object.values(metafile.inputs)) {
      for (const imp of info.imports) if (imp.external && !imp.path.startsWith("node:")) external.add(pkgName(imp.path));
    }
    expect([...external].filter((p) => !builtins.has(p) && !deps.has(p))).toEqual([]);
  });

  it("bundles every loop's module, so each registry entry loads in the worker", () => {
    const registry = readFileSync(join(root, "lib/worker/registry.ts"), "utf8");
    const modules = [...registry.matchAll(/import\("@\/(lib\/[^"]+)"\)/g)].map((m) => m[1]);
    const inputs = Object.keys(metafile.inputs);
    for (const mod of modules) expect(inputs.some((f) => f === `${mod}.ts` || f === `${mod}/index.ts`)).toBe(true);
  });
});
