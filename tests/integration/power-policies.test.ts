// UPS power policies against a scratch database: the deploy hold and the stop and restart of apps.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import type { PowerState } from "@/lib/ups/power-state";
import type { StopCandidate } from "@/lib/power/policy";
import type { AppControl } from "@/lib/power/stops";

const { power, emitted } = vi.hoisted(() => ({
  power: { value: null as PowerState | null },
  emitted: [] as { orgId: string; action: string; title: string }[],
}));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/stream/producer", () => ({ addDeployLog: vi.fn(async () => {}) }));
vi.mock("@/lib/ups/power-state", () => ({ getPowerState: async () => power.value }));
vi.mock("@/lib/power/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/power/settings")>();
  return { ...actual, getPowerPolicies: async () => ({ ...actual.DEFAULT_POWER_POLICIES, stopApps: true, stopAfterMinutes: 10, stopBelowCharge: 20 }) };
});
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: { action: string; title: string }) => void emitted.push({ orgId, action: event.action, title: event.title }),
}));

const conn = await connectScratchServer();

const T0 = new Date("2026-11-11T12:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1_000);

function state(onBattery: boolean, since: Date | null, charge = 80): PowerState {
  return { monitored: true, onBattery, graceElapsed: onBattery, since, charge, runtimeSec: 900, fresh: true, upses: [] };
}

describe.skipIf(!conn)("power policies on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("power");
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 4, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into organization (id, name, slug) values ('o1', 'Org', 'org')`;
      const rows: [string, string, string, boolean, boolean][] = [
        ["preview", "disposable", "active", false, false],
        ["blog", "standard", "active", false, false],
        ["shop", "standard", "active", false, false],
        ["db", "critical", "active", false, false],
        ["pager", "critical", "active", true, false],
        ["loki", "standard", "active", false, true],
        ["vardo", "critical", "active", false, false],
        ["old", "standard", "stopped", false, false],
      ];
      for (const [id, priority, status, keep, system] of rows) {
        await t`insert into app (id, organization_id, name, display_name, project_id, priority, status, keep_running_on_battery, is_system_managed)
          values (${id}, 'o1', ${id}, ${id}, 'p1', ${priority}, ${status}, ${keep}, ${system})`;
      }
    });
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  describe("deploy hold", () => {
    let q: typeof import("@/lib/deploy/queue");
    let w: typeof import("@/lib/deploy/waiting");
    let d: typeof import("@/lib/power/deploys");

    beforeAll(async () => {
      q = await import("@/lib/deploy/queue");
      w = await import("@/lib/deploy/waiting");
      d = await import("@/lib/power/deploys");
    });

    beforeEach(async () => {
      await sql`delete from deployment`;
    });

    async function seed(id: string, appId: string, trigger: "manual" | "webhook" | "rollback", request: Record<string, unknown> | null = null) {
      await sql`insert into deployment (id, app_id, trigger, status, scope_key, request) values (${id}, ${appId}, ${trigger}, 'queued', ${appId}, ${request ? sql.json(request as postgres.JSONValue) : null})`;
    }

    it("claims only rollbacks while held, and everything once power is back", async () => {
      await seed("push", "blog", "webhook");
      await seed("click", "shop", "manual");
      await seed("back", "db", "rollback", { rollback: { targetDeploymentId: "x" } });
      expect((await q.claimDeploys("w", { capacity: 10, powerHold: true })).map((c) => c.id)).toEqual(["back"]);
      expect((await q.claimDeploys("w", { capacity: 10, powerHold: false })).map((c) => c.id).sort()).toEqual(["click", "push"]);
    });

    it("says why a held deploy waits", async () => {
      await seed("click", "shop", "manual");
      await w.markQueueWaits({ capacity: 10, targets: null, workerMissing: false, powerHold: true });
      expect((await sql`select wait_reason from deployment where id = 'click'`)[0].wait_reason).toBe("power");
      await w.markQueueWaits({ capacity: 10, targets: null, workerMissing: false, powerHold: false });
      expect((await sql`select wait_reason from deployment where id = 'click'`)[0].wait_reason).toBeNull();
    });

    it("lets an overridden deploy through the hold and keeps its request", async () => {
      await seed("click", "shop", "manual", { gitSha: "abc" });
      await seed("other", "blog", "manual");
      expect(await d.allowOnBattery("click")).toBe(true);
      const claimed = await q.claimDeploys("w", { capacity: 10, powerHold: true });
      expect(claimed.map((c) => c.id)).toEqual(["click"]);
      expect(claimed[0].request).toMatchObject({ gitSha: "abc", powerOverride: true });
    });

    it("lets an import's deploy through, since its originals are already stopped", async () => {
      const { id } = await q.enqueueDeploy({ appId: "shop", trigger: "manual" }, { hold: true });
      expect(await q.releaseHeldDeploy(id)).toBe(true);
      expect((await q.claimDeploys("w", { capacity: 10, powerHold: true })).map((c) => c.id)).toEqual([id]);
    });

    it("won't override a deploy that already left the queue", async () => {
      await sql`insert into deployment (id, app_id, trigger, status) values ('done', 'blog', 'manual', 'success')`;
      expect(await d.allowOnBattery("done")).toBe(false);
    });
  });

  describe("stop and restart", () => {
    const events: string[] = [];
    const control: AppControl = {
      async stop(app: StopCandidate) {
        events.push(`stop ${app.name}`);
        await sql`update app set status = 'stopped', parked = true where id = ${app.id}`;
        return { success: true, log: "" };
      },
      async start(app: StopCandidate) {
        events.push(`start ${app.name}`);
        await sql`update app set status = 'active', parked = false where id = ${app.id}`;
        return { success: true, log: "" };
      },
    };
    const fresh = async () => {
      vi.resetModules();
      return import("@/lib/power/stops");
    };

    it("stops low priority first, survives a restart and brings back only what it stopped", async () => {
      const outage = at(-11 * 60);
      power.value = state(true, outage);
      let s = await fresh();

      await s.tickPowerPolicy(at(0), control);
      expect(events).toEqual(["stop preview", "stop blog", "stop shop", "stop db"]);
      expect(emitted.map((e) => e.title)).toEqual(["Stopped 4 apps after 11 min on battery"]);

      // The pass runs once per outage, even for an app someone starts meanwhile.
      await sql`update app set status = 'active', parked = false where id = 'shop'`;
      await s.tickPowerPolicy(at(15), control);
      expect(events).toHaveLength(4);

      // Vardo restarts mid-outage: the record is in the database.
      s = await fresh();
      expect((await s.openStops()).map((r) => r.appId).sort()).toEqual(["blog", "db", "preview", "shop"]);

      // Mains, then a bounce before the settle time is up.
      power.value = state(false, null);
      await s.tickPowerPolicy(at(60), control);
      await s.tickPowerPolicy(at(150), control);
      power.value = state(true, at(165));
      await s.tickPowerPolicy(at(170), control);
      power.value = state(false, null);
      await s.tickPowerPolicy(at(180), control);
      await s.tickPowerPolicy(at(299), control);
      expect(events).toHaveLength(4);

      await s.tickPowerPolicy(at(300), control);
      expect(events.slice(4)).toEqual(["start db", "start blog", "start preview"]);
      expect(emitted.at(-1)?.title).toBe("Restarted 3 apps");
      expect(await s.openStops()).toEqual([]);
      const outcomes = await sql`select app_id, outcome from power_stopped_app order by app_id`;
      expect(outcomes.map((r) => [r.app_id, r.outcome])).toEqual([
        ["blog", "restarted"],
        ["db", "restarted"],
        ["preview", "restarted"],
        ["shop", "already-running"],
      ]);

      // Nothing left to restart: further mains ticks do nothing.
      await s.tickPowerPolicy(at(400), control);
      expect(events).toHaveLength(7);
    });

    it("restarts by hand only the open records, once, with no UPS left", async () => {
      await sql`delete from power_stopped_app`;
      await sql`delete from power_action`;
      await sql`update app set status = 'stopped', parked = true where id in ('blog', 'db', 'shop')`;
      await sql`insert into power_stopped_app (id, app_id, organization_id, outage_started_at) values ('s1', 'blog', 'o1', now()), ('s2', 'db', 'o1', now())`;
      await sql`insert into power_stopped_app (id, app_id, organization_id, outage_started_at, restored_at, outcome) values ('s3', 'shop', 'o1', now(), now(), 'failed')`;
      events.length = 0;
      power.value = { monitored: false, onBattery: false, graceElapsed: false, since: null, charge: null, runtimeSec: null, fresh: false, upses: [] };
      const s = await fresh();

      expect(await s.restartStoppedByHand(at(2_000), control)).toEqual(["db", "blog"]);
      expect(events).toEqual(["start db", "start blog"]);
      const rows = await sql`select id, outcome, restored_at is not null as restored from power_stopped_app order by id`;
      expect(rows.map((r) => [r.id, r.outcome, r.restored])).toEqual([
        ["s1", "restarted", true],
        ["s2", "restarted", true],
        ["s3", "failed", true],
      ]);
      expect((await sql`select title from power_action`).map((r) => r.title)).toEqual(["Restarted 2 apps by hand"]);

      expect(await s.restartStoppedByHand(at(2_010), control)).toEqual([]);
      expect(events).toHaveLength(2);
      expect(await sql`select count(*)::int as n from power_action`).toEqual([{ n: 1 }]);
    });

    it("stops at low charge before the minutes are up", async () => {
      await sql`delete from power_stopped_app`;
      await sql`delete from power_action`;
      await sql`update app set status = 'active', parked = false where id in ('preview', 'blog', 'shop', 'db')`;
      events.length = 0;
      power.value = state(true, at(1_000), 20);
      const s = await fresh();
      await s.tickPowerPolicy(at(1_060), control);
      expect(events).toEqual(["stop preview", "stop blog", "stop shop", "stop db"]);
      expect(emitted.at(-1)?.title).toBe("Stopped 4 apps at 20% charge");
    });
  });
});
