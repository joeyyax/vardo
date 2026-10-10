import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LOOP_NAMES, LOOP_REGISTRY } from "@/lib/worker/registry";
import { startLoops } from "@/lib/worker/start";
import type { IntervalLoop } from "@/lib/worker/interval-loop";

const LIB = path.resolve(import.meta.dirname, "../../../../lib");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Every loop name declared with `new IntervalLoop({ name: ... })`, read from the source. */
function declaredLoopNames(): string[] {
  const names: string[] = [];
  for (const file of sources(LIB)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/new IntervalLoop\(\{\s*name: "([a-z-]+)"/g)) names.push(match[1]!);
  }
  return names;
}

describe("loop registry", () => {
  it("lists each loop once", () => {
    expect(new Set(LOOP_NAMES).size).toBe(LOOP_NAMES.length);
  });

  it("every declared loop is registered, and every registered loop is declared", () => {
    // A loop missing from the registry never starts and never shows on the system screen.
    expect([...declaredLoopNames()].sort()).toEqual([...LOOP_NAMES].sort());
  });

  it("each entry loads the loop it names", async () => {
    for (const entry of LOOP_REGISTRY) {
      const loop = await entry.load();
      expect(loop.name).toBe(entry.name);
    }
  }, 60_000);

  it("starts only the loops for the role, with the entry's singleton and feature", async () => {
    const start = vi.fn();
    const fake = (name: string) => ({ name, start }) as unknown as IntervalLoop;
    await startLoops({
      role: "worker",
      registry: [
        { name: "a", roles: ["web", "worker"], singleton: true, load: async () => fake("a") },
        { name: "b", roles: ["web"], singleton: false, load: async () => fake("b") },
      ],
    });
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({ role: "worker", singleton: true, feature: undefined });
  });

  it("waits for a loop's boot step", async () => {
    const start = vi.fn();
    let ready!: () => void;
    const backupTarget = new Promise<void>((r) => (ready = r));
    const starting = startLoops({
      role: "web",
      ready: { "backup-target": backupTarget },
      registry: [{ name: "c", roles: ["web"], singleton: true, after: "backup-target", load: async () => ({ name: "c", start }) as unknown as IntervalLoop }],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(start).not.toHaveBeenCalled();
    ready();
    await starting;
    expect(start).toHaveBeenCalledOnce();
  });
});
