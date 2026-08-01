import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake table keyed the way container_self_heal is: one row per container id.
// The where() clauses are ignored — the store windows every value it reads back,
// so the assertions below exercise that filtering rather than fake SQL.
const { rows, deleteSpy, dbMock } = vi.hoisted(() => {
  type Row = {
    containerId: string;
    appId: string;
    restarts: number[];
    gaveUpAt: Date | null;
    updatedAt: Date;
  };
  const rows = new Map<string, Row>();
  const deleteSpy = vi.fn();

  return {
    rows,
    deleteSpy,
    dbMock: {
      select: () => ({
        from: () => ({
          where: async () => [...rows.values()].map((r) => ({ ...r })),
        }),
      }),
      insert: () => ({
        values: (v: Row) => ({
          onConflictDoUpdate: async ({ set }: { set: Partial<Row> }) => {
            rows.set(v.containerId, { ...v, ...set, containerId: v.containerId });
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          deleteSpy();
        },
      }),
    },
  };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  RESTART_WINDOW_MS,
  clearGaveUp,
  hasGivenUp,
  hydrateSelfHealState,
  pruneSelfHealState,
  recentRestarts,
  recordGaveUp,
  recordRestart,
  resetSelfHealCache,
} from "@/lib/docker/self-heal-store";
import { MAX_RESTARTS_PER_WINDOW, decideRestart, CONFIRM_STREAK } from "@/lib/docker/health-monitor";

const NOW = 1_700_000_000_000;
const APP = "app-1";
const CONTAINER = "c-abc";

/** Wipe the in-memory mirror and re-read the table, exactly as a process
 *  restart does. The fake table survives. */
async function restartVardo(now: number): Promise<void> {
  resetSelfHealCache();
  await hydrateSelfHealState(now);
}

/** Spend the whole budget, spread so backoff never masks the cap. */
async function burnBudget(startAt: number): Promise<number> {
  let at = startAt;
  for (let i = 0; i < MAX_RESTARTS_PER_WINDOW; i++) {
    await recordRestart(APP, CONTAINER, at);
    at += 6 * 60_000;
  }
  return at;
}

beforeEach(async () => {
  rows.clear();
  deleteSpy.mockClear();
  resetSelfHealCache();
  await hydrateSelfHealState(NOW);
});

describe("restart budget across a process restart", () => {
  it("does not hand a container a fresh cap after Vardo restarts", async () => {
    const after = await burnBudget(NOW);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: recentRestarts(CONTAINER, after), now: after })).toBe("giveup");

    await restartVardo(after);

    expect(recentRestarts(CONTAINER, after)).toHaveLength(MAX_RESTARTS_PER_WINDOW);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: recentRestarts(CONTAINER, after), now: after })).toBe("giveup");
  });

  it("keeps the give-up marker so the escalation is not silently lost", async () => {
    const after = await burnBudget(NOW);
    await recordGaveUp(APP, CONTAINER, after);

    await restartVardo(after);

    expect(hasGivenUp(CONTAINER, after)).toBe(true);
  });

  it("restores a partially spent budget rather than rounding it to zero", async () => {
    await recordRestart(APP, CONTAINER, NOW);
    await recordRestart(APP, CONTAINER, NOW + 6 * 60_000);

    await restartVardo(NOW + 7 * 60_000);

    expect(recentRestarts(CONTAINER, NOW + 7 * 60_000)).toEqual([NOW, NOW + 6 * 60_000]);
  });
});

describe("window pruning", () => {
  it("ignores restarts that have aged out of the window", async () => {
    await recordRestart(APP, CONTAINER, NOW);
    const later = NOW + RESTART_WINDOW_MS + 1;

    expect(recentRestarts(CONTAINER, later)).toEqual([]);
  });

  it("drops aged-out timestamps on hydrate even though the row still holds them", async () => {
    await burnBudget(NOW);
    // Half the budget is now older than the window, half is not.
    const later = NOW + RESTART_WINDOW_MS + 13 * 60_000;

    await restartVardo(later);

    const live = recentRestarts(CONTAINER, later);
    expect(live).toHaveLength(2);
    expect(live.every((t) => t > later - RESTART_WINDOW_MS)).toBe(true);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: live, now: later })).toBe("restart");
  });

  it("expires the give-up marker with the window that refilled the budget", async () => {
    await recordGaveUp(APP, CONTAINER, NOW);

    expect(hasGivenUp(CONTAINER, NOW + RESTART_WINDOW_MS - 1)).toBe(true);
    expect(hasGivenUp(CONTAINER, NOW + RESTART_WINDOW_MS + 1)).toBe(false);
  });

  it("evicts spent containers from the mirror and deletes at most once per window", async () => {
    await recordRestart(APP, CONTAINER, NOW);

    await pruneSelfHealState(NOW); // startup sweep
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    await pruneSelfHealState(NOW + 60_000);
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    const later = NOW + RESTART_WINDOW_MS + 1;
    await pruneSelfHealState(later);
    await pruneSelfHealState(later + 60_000);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(recentRestarts(CONTAINER, later)).toEqual([]);
  });
});

describe("recreated containers", () => {
  it("gives a new container id its own budget", async () => {
    const after = await burnBudget(NOW);
    await recordGaveUp(APP, CONTAINER, after);

    // Redeploy: same app, new container id.
    const recreated = "c-def";
    await restartVardo(after);

    expect(recentRestarts(recreated, after)).toEqual([]);
    expect(hasGivenUp(recreated, after)).toBe(false);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: recentRestarts(recreated, after), now: after })).toBe("restart");
    // The replaced container keeps its own exhausted state until it ages out.
    expect(hasGivenUp(CONTAINER, after)).toBe(true);
  });

  it("keeps each container's budget separate", async () => {
    await recordRestart(APP, "c-one", NOW);
    await recordRestart(APP, "c-two", NOW);
    await recordRestart(APP, "c-two", NOW + 6 * 60_000);

    await restartVardo(NOW + 7 * 60_000);

    expect(recentRestarts("c-one", NOW + 7 * 60_000)).toHaveLength(1);
    expect(recentRestarts("c-two", NOW + 7 * 60_000)).toHaveLength(2);
  });
});

describe("give-up marker lifecycle", () => {
  it("clears when the container reads healthy, and stays cleared across a restart", async () => {
    const after = await burnBudget(NOW);
    await recordGaveUp(APP, CONTAINER, after);

    await clearGaveUp(CONTAINER, after);
    expect(hasGivenUp(CONTAINER, after)).toBe(false);

    await restartVardo(after);
    expect(hasGivenUp(CONTAINER, after)).toBe(false);
  });

  it("leaves the spent budget in place when the marker is cleared", async () => {
    const after = await burnBudget(NOW);
    await recordGaveUp(APP, CONTAINER, after);
    await clearGaveUp(CONTAINER, after);

    await restartVardo(after);

    expect(recentRestarts(CONTAINER, after)).toHaveLength(MAX_RESTARTS_PER_WINDOW);
  });

  it("writes nothing when there is no marker to clear", async () => {
    await clearGaveUp("never-seen", NOW);
    expect(rows.size).toBe(0);
  });
});

describe("hydration", () => {
  it("reads the table once per process, so the tick adds no queries", async () => {
    resetSelfHealCache();
    const spy = vi.spyOn(dbMock, "select");

    await hydrateSelfHealState(NOW);
    await hydrateSelfHealState(NOW + 30_000);
    await hydrateSelfHealState(NOW + 60_000);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("survives a restart mid-window without losing the budget it just wrote", async () => {
    await recordRestart(APP, CONTAINER, NOW);
    await restartVardo(NOW + 1_000);
    await recordRestart(APP, CONTAINER, NOW + 6 * 60_000);
    await restartVardo(NOW + 7 * 60_000);

    expect(recentRestarts(CONTAINER, NOW + 7 * 60_000)).toEqual([NOW, NOW + 6 * 60_000]);
  });
});
