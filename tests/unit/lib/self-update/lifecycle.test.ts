import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = new Map<string, string>();
const claims = new Set<string>();
const openIncidents = new Map<string, { id: string; transition: string }>();
const emitted: { orgId: string; event: { type: string } & Record<string, unknown> }[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      systemSettings: {
        findFirst: async ({ where }: { where: (t: unknown, ops: unknown) => unknown }) => {
          let key = "";
          where({ key: "key" }, { eq: (_: unknown, value: string) => (key = value) });
          const value = settings.get(key);
          return value === undefined ? undefined : { key, value };
        },
      },
    },
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          settings.set(row.key, row.value);
        },
      }),
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({ systemSettings: { key: "key" } }));
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: { type: string }) => emitted.push({ orgId, event }),
}));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: async () => ["org_admin"] }));
vi.mock("@/lib/redis-lock", () => ({
  acquireLock: async (key: string) => {
    if (claims.has(key)) return null;
    claims.add(key);
    return "token";
  },
}));
vi.mock("@/lib/incidents/store", () => ({
  safely: async <T,>(_what: string, fn: () => Promise<T>, fallback: T) => fn().catch(() => fallback),
  openIncident: async (_org: string, req: { about: string }) => {
    const ref = { id: `inc_${req.about}`, transition: openIncidents.has(req.about) ? "updated" : "opened" };
    openIncidents.set(req.about, ref);
    return ref;
  },
  resolveIncidents: async (_org: string, _kind: string, abouts: string[]) => {
    const out = new Map<string, { id: string; transition: string }>();
    for (const about of abouts) {
      if (!openIncidents.delete(about)) continue;
      out.set(about, { id: `inc_${about}`, transition: "resolved" });
    }
    return out;
  },
}));
vi.mock("@/lib/version", () => ({ fetchCompare: async () => null, moreCommits: () => ({}) }));

const lifecycle = await import("@/lib/self-update/lifecycle");
const { activeUpdate, awaitResult, ingestUpdateMarker, reconcileUpdate, updateFailed, updateFinished, updateSkipped, updateStarted } = lifecycle;

const T0 = Date.parse("2026-10-10T12:00:00Z");
const facts = {
  id: "20261010120000-42",
  source: "install" as const,
  startedAt: T0,
  fromVersion: "0.1.0 (bc2083d)",
  toVersion: "0.1.0 (559e5b2)",
  fromSlot: "blue",
  toSlot: "green",
};
const types = () => emitted.map((e) => e.event.type);

beforeEach(() => {
  settings.clear();
  claims.clear();
  openIncidents.clear();
  emitted.length = 0;
});

describe("update lifecycle", () => {
  it("sends updating at once, then updated in the same incident", async () => {
    expect(await updateStarted(facts, { now: T0 + 1_000 })).toBe(true);
    expect(emitted[0]).toMatchObject({
      orgId: "org_admin",
      event: { type: "system.update-started", title: "Updating Vardo to 559e5b2…", toVersion: "0.1.0 (559e5b2)", incident: { id: `inc_${facts.id}`, transition: "opened" } },
    });

    expect(await updateFinished({ id: facts.id, finishedAt: T0 + 90_000 }, { now: T0 + 90_000 })).toBe(true);
    expect(types()).toEqual(["system.update-started", "system.updated"]);
    expect(emitted[1].event).toMatchObject({ durationSeconds: 90, incident: { id: `inc_${facts.id}`, transition: "resolved" } });
  });

  it("sends a failure in the same incident", async () => {
    await updateStarted(facts, { now: T0 });
    await updateFailed({ id: facts.id, step: "Health check", error: "unhealthy", rolledBack: true }, { now: T0 + 60_000 });
    expect(types()).toEqual(["system.update-started", "system.update-failed"]);
    expect(emitted[1].event).toMatchObject({ step: "Health check", rolledBack: true, incident: { id: `inc_${facts.id}`, transition: "resolved" } });
  });

  it("sends each notice once, across reports and consoles", async () => {
    await updateStarted(facts, { now: T0 });
    await updateStarted(facts, { now: T0 + 5_000 });
    // Another console with its own record claims nothing new.
    settings.clear();
    await updateStarted(facts, { now: T0 + 10_000 });
    await updateFinished({ id: facts.id }, { now: T0 + 20_000 });
    await updateFinished({ id: facts.id }, { now: T0 + 25_000 });
    expect(types()).toEqual(["system.update-started", "system.updated"]);
  });

  it("records a start without sending it when told not to", async () => {
    expect(await updateStarted(facts, { notify: false, now: T0 })).toBe(false);
    expect(emitted).toEqual([]);
    expect(await activeUpdate(T0 + 1_000)).toMatchObject({ id: facts.id, toVersion: "0.1.0 (559e5b2)" });
  });

  it("stays quiet about a redeploy of the same commit", async () => {
    const same = { ...facts, toVersion: "0.1.0 (bc2083d)" };
    await updateStarted(same, { now: T0 });
    await updateFinished({ id: same.id }, { now: T0 + 10_000 });
    expect(emitted).toEqual([]);
  });

  it("ignores a late start for an update that already ended", async () => {
    await updateFinished({ ...facts }, { now: T0 + 10_000 });
    await updateStarted(facts, { now: T0 + 20_000 });
    expect(types()).toEqual(["system.updated"]);
  });

  it("sends skipped notices", async () => {
    await updateSkipped({ fromVersion: "0.1.0", target: "v0.2.0", reasons: ["A backup is running"] });
    expect(emitted[0].event).toMatchObject({ type: "system.update-skipped", target: "v0.2.0", message: "A backup is running" });
  });
});

describe("the updating indicator", () => {
  it("shows while running and clears on the result", async () => {
    await updateStarted(facts, { now: T0 });
    expect(await activeUpdate(T0 + 60_000)).toMatchObject({ id: facts.id, startedAt: T0 });
    await updateFinished({ id: facts.id }, { now: T0 + 90_000 });
    expect(await activeUpdate(T0 + 91_000)).toBeNull();
  });

  it("clears on a failure", async () => {
    await updateStarted(facts, { now: T0 });
    await updateFailed({ id: facts.id, step: "Building green slot" }, { now: T0 + 60_000 });
    expect(await activeUpdate(T0 + 61_000)).toBeNull();
  });

  it("expires on its own, and the reconciler fails the update once", async () => {
    await updateStarted(facts, { now: T0 });
    const late = T0 + lifecycle.UPDATE_EXPIRES_MS;
    expect(await activeUpdate(late)).toBeNull();
    expect(await reconcileUpdate(late)).toBe(true);
    expect(await reconcileUpdate(late + 60_000)).toBe(false);
    expect(types()).toEqual(["system.update-started", "system.update-failed"]);
    expect(String(emitted[1].event.error)).toContain("didn't report");
  });

  it("gives a console that booted mid-update a shorter wait", async () => {
    await updateStarted(facts, { notify: false, now: T0 });
    await awaitResult(T0 + 60_000);
    const deadline = T0 + 60_000 + lifecycle.UPDATE_WAIT_MS;
    expect(await reconcileUpdate(deadline - 1)).toBe(false);
    expect(await reconcileUpdate(deadline)).toBe(true);
  });
});

describe("install.sh's marker", () => {
  const ctx = { host: "console-new", processStartedAt: T0 - 60 * 60_000 };
  const marker = { ...facts, state: "started" as const, kind: "install" as const };

  it("reports the start from the console that was running", async () => {
    expect(await ingestUpdateMarker(marker, { ...ctx, now: T0 + 5_000 })).toBe("started");
    expect(await ingestUpdateMarker({ ...marker, state: "updated", finishedAt: T0 + 60_000, swapStartedAt: T0 + 40_000, healthyAt: T0 + 52_000 }, { ...ctx, now: T0 + 61_000 })).toBe("updated");
    expect(types()).toEqual(["system.update-started", "system.updated"]);
    expect(emitted[1].event).toMatchObject({ downSeconds: 12, durationSeconds: 60 });
  });

  it("doesn't send the start from a console that booted after it", async () => {
    expect(await ingestUpdateMarker(marker, { ...ctx, processStartedAt: T0 + 30_000, now: T0 + 40_000 })).toBeNull();
    expect(await activeUpdate(T0 + 40_000)).not.toBeNull();
  });

  it("leaves a self-deploy's result to the console it started", async () => {
    const selfDeploy = { ...marker, kind: "self-deploy" as const, fromHost: "console-old", state: "updated" as const, finishedAt: T0 + 60_000 };
    expect(await ingestUpdateMarker(selfDeploy, { ...ctx, host: "console-old", now: T0 + 61_000 })).toBeNull();
    expect(await ingestUpdateMarker(selfDeploy, { ...ctx, host: "console-new", now: T0 + 62_000 })).toBe("updated");
  });

  it("ignores markers older than a day", async () => {
    expect(await ingestUpdateMarker({ ...marker, state: "updated", finishedAt: T0 }, { ...ctx, now: T0 + 25 * 60 * 60_000 })).toBeNull();
  });
});
