import { describe, expect, it, vi } from "vitest";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { drainWork } from "@/worker/drain";

vi.mock("@/lib/worker/jobs", () => ({ recordTick: vi.fn(async () => {}) }));
vi.mock("@/lib/worker/tick-failure", () => ({
  logTickFailure: vi.fn(),
  recordTickFailure: vi.fn(async () => {}),
  recordTickOk: vi.fn(async () => {}),
}));

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };

describe("worker drain", () => {
  it("lets a pass in flight finish before the loop stops, inside the budget", async () => {
    let finish!: () => void;
    let finished = false;
    const loop = new IntervalLoop({
      name: "drain-test",
      intervalMs: 60_000,
      firstRunMs: 60_000,
      log: quiet,
      run: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            finished = true;
            resolve();
          };
        }),
    });
    loop.start();
    const pass = loop.tick();
    expect(loop.busy).toBe(true);

    const drained = drainWork({ stopLoops: () => loop.stop(), drainBackups: async () => {}, budgetMs: 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false);
    finish();
    expect(await drained).toBe("drained");
    expect(finished).toBe(true);
    expect(loop.started).toBe(false);
    await pass;
  });

  it("stops waiting at the budget", async () => {
    const result = await drainWork({ stopLoops: () => new Promise(() => {}), drainBackups: async () => {}, budgetMs: 20 });
    expect(result).toBe("timeout");
  });

  it("waits for backup work with the same budget", async () => {
    const drainBackups = vi.fn(async () => {});
    await drainWork({ stopLoops: async () => {}, drainBackups, budgetMs: 1234 });
    expect(drainBackups).toHaveBeenCalledWith(1234);
  });
});
