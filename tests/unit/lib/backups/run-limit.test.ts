// A run whose upload outgrows one slot's memory holds more slots while it streams.

import { describe, it, expect } from "vitest";
import { backupSlotsBusy, withBackupSlot, withSlotWeight } from "@/lib/backups/run-limit";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("withSlotWeight", () => {
  it("waits for a second free slot and keeps later runs behind it", async () => {
    const order: string[] = [];
    const a = gate();
    const b = gate();
    const big = gate();
    const runA = withBackupSlot(2, async () => {
      await a.opened;
      await withSlotWeight(2, async () => {
        order.push("big start");
        await big.opened;
      });
      order.push("big done");
    });
    const runB = withBackupSlot(2, () => b.opened.then(() => void order.push("b done")));
    await settle();

    a.open();
    await settle();
    const runC = withBackupSlot(2, async () => void order.push("c start"));
    await settle();
    expect(order).toEqual([]);

    b.open();
    await settle();
    expect(order).toEqual(["b done", "big start"]);

    big.open();
    await Promise.all([runA, runB, runC]);
    expect(order).toContain("c start");
    expect(backupSlotsBusy()).toBe(false);
  });

  it("doesn't deadlock when two runs grow at once", async () => {
    const grow = () => withBackupSlot(2, () => withSlotWeight(2, settle));
    await Promise.all([grow(), grow()]);
    expect(backupSlotsBusy()).toBe(false);
  });

  it("caps the claim at the limit", async () => {
    await withBackupSlot(2, () => withSlotWeight(5, settle));
    expect(backupSlotsBusy()).toBe(false);
  });
});

describe("withBackupSlot", () => {
  it("lets a run already in a slot nest without claiming another", async () => {
    expect(await withBackupSlot(1, () => withBackupSlot(1, async () => "ran"))).toBe("ran");
  });
});
