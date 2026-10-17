// Queued deploys on build target slots, against a scratch database and a real Redis: deploy concurrency 1 and Long House taking 1 build.
// Skips without a Postgres it can create databases on or a Redis at REDIS_URL or localhost:7200.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import Redis from "ioredis";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

async function connectRedis(): Promise<Redis | null> {
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:7200", { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const conn = await connectScratchServer();
const client = await connectRedis();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!conn || !client)("deploys on build target slots", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("targetslots");
  const prefix = `test:target-slots:${process.pid}:${Date.now()}`;
  const keys = Object.fromEntries(
    ["queue", "seen", "running", "hold", "admits", "started", "remote", "target", "ready"].map((k) => [k, `${prefix}:${k}${k === "target" ? ":" : ""}`]),
  ) as Parameters<typeof import("@/lib/docker/build-gate").redisBuildStore>[0];
  let sql: ReturnType<typeof postgres>;
  let q: typeof import("@/lib/deploy/queue");
  let w: typeof import("@/lib/deploy/waiting");
  let gate: typeof import("@/lib/docker/build-gate");
  let targets: typeof import("@/lib/docker/build-targets");

  const longHouse = {
    id: "mesh-lh", kind: "mesh" as const, name: "Long House", host: "10.99.0.2", port: 22, user: "vardo",
    privateKey: "key", hostKey: "10.99.0.2 ssh-ed25519 AAAA", maxConcurrent: 1, peerId: "lh",
  };
  const bounded = { env: {}, loadArgs: [], limitBytes: null };
  const view = () => gate.targetSlotView({ load: async () => [longHouse], check: async () => {} });

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 4, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      for (const id of ["a1", "a2", "a3"]) {
        await t`insert into app (id, organization_id, name, display_name, project_id) values (${id}, 'o1', ${id}, ${id}, 'p1')`;
      }
    });
    q = await import("@/lib/deploy/queue");
    w = await import("@/lib/deploy/waiting");
    gate = await import("@/lib/docker/build-gate");
    targets = await import("@/lib/docker/build-targets");
    // jy0's setting: one deploy at a time.
    (await import("@/lib/resources/host")).setResourceSettingsCache({ deployConcurrency: 1 });
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    const left = await client!.keys(`${prefix}:*`);
    if (left.length > 0) await client!.del(...left);
    client!.disconnect();
    (await import("@/lib/redis")).redis.disconnect();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    await sql`delete from deployment`;
    const left = await client!.keys(`${prefix}:*`);
    if (left.length > 0) await client!.del(...left);
    gate.resetBuildGateForTests(gate.redisBuildStore(keys, client! as never));
    targets.resetTargetHealth();
    // A first check has answered, as on a running worker.
    await targets.isTargetReady(longHouse, async () => {});
  });

  async function seed(id: string, appId: string, ageS: number) {
    await sql`
      insert into deployment (id, app_id, trigger, status, scope_key, started_at)
      values (${id}, ${appId}, 'manual', 'queued', ${appId}, now() - ${ageS}::int * interval '1 second')`;
  }

  const row = async (id: string) => (await sql`select status, claim_slot, wait_reason from deployment where id = ${id}`)[0];
  const finish = (id: string) => sql`update deployment set status = 'success', finished_at = now() where id = ${id}`;
  const gateFor = (id: string, slot?: import("@/lib/docker/build-gate").DeploySlot, extra: { targets?: (typeof longHouse)[] } = {}) => ({
    deploymentId: id,
    log: () => {},
    wait: async () => {},
    deploySlot: slot,
    ...extra,
  });

  it("claims two queued deploys at a limit of one, the second on Long House's slot, where it builds", async () => {
    await seed("d1", "a1", 30);
    await seed("d2", "a2", 20);
    await seed("d3", "a3", 10);

    const claimed = await q.claimDeploys("ex", { targets: await view() });
    expect(claimed.map((c) => [c.id, c.onTarget ?? false])).toEqual([["d1", false], ["d2", true]]);
    expect(claimed[1].note).toBe("[queue] Started on Long House's build slot (this server runs 1 deploy at a time)");
    expect((await row("d2")).claim_slot).toBe("target");
    // This server's slot and Long House's are both taken.
    expect(await q.claimDeploys("ex", { targets: await view() })).toEqual([]);

    // This host's builder is free, and the deploy on Long House's slot still builds there.
    const placed: Record<string, string | null> = {};
    let finishRemote!: () => void;
    const remote = gate.withBuildSlot(gateFor("d2", q.claimedSlot("ex", claimed[1]), { targets: [longHouse] }), bounded, async ({ target }) => {
      placed.d2 = target?.id ?? null;
      await new Promise<void>((r) => (finishRemote = r));
    });
    await sleep(100);
    expect(placed.d2).toBe("mesh-lh");
    expect((await view()).holders).toEqual(["d2"]);

    await gate.withBuildSlot(gateFor("d1", q.claimedSlot("ex", claimed[0]), { targets: [longHouse] }), bounded, async ({ target }) => {
      placed.d1 = target?.id ?? null;
    });
    expect(placed.d1).toBeNull();
    finishRemote();
    await remote;

    // The target build ended, but the deploy holds Long House's slot until it finishes.
    expect(await q.claimDeploys("ex", { targets: await view() })).toEqual([]);
    await finish("d2");
    expect((await q.claimDeploys("ex", { targets: await view() })).map((c) => [c.id, c.onTarget ?? false])).toEqual([["d3", true]]);
  });

  it("puts a deploy back in the queue when its build runs only here, and claims it here once this server's slot frees", async () => {
    await seed("d1", "a1", 30);
    await seed("d2", "a2", 20);
    const claimed = await q.claimDeploys("ex", { targets: await view() });
    expect(claimed[1]).toMatchObject({ id: "d2", onTarget: true });

    // A Railpack build: no targets.
    const built = vi.fn();
    await expect(gate.withBuildSlot(gateFor("d2", q.claimedSlot("ex", claimed[1])), bounded, built)).rejects.toBeInstanceOf(gate.NeedsLocalDeploySlotError);
    expect(built).not.toHaveBeenCalled();
    expect(await q.requeueForLocalSlot("ex", "d2", "kept log")).toBe(true);
    expect(await row("d2")).toMatchObject({ status: "queued", claim_slot: "local" });

    // Long House's slot goes to the next deploy that may build there.
    await seed("d3", "a3", 10);
    expect((await q.claimDeploys("ex", { targets: await view() })).map((c) => [c.id, c.onTarget ?? false])).toEqual([["d3", true]]);

    await finish("d1");
    expect((await q.claimDeploys("ex", { targets: await view() })).map((c) => [c.id, c.onTarget ?? false])).toEqual([["d2", false]]);
    expect((await row("d2")).claim_slot).toBeNull();
  });

  it("builds here at once when its build runs only here and this server's slot is free", async () => {
    await seed("d1", "a1", 30);
    await seed("d2", "a2", 20);
    const claimed = await q.claimDeploys("ex", { targets: await view() });
    await finish("d1");
    const slot = q.claimedSlot("ex", claimed[1]);
    const placed: (string | null)[] = [];
    await gate.withBuildSlot(gateFor("d2", slot), bounded, async ({ target }) => void placed.push(target?.id ?? null));
    expect(placed).toEqual([null]);
    expect(slot.onTarget()).toBe(false);
    expect((await row("d2")).claim_slot).toBeNull();
  });

  it("after Long House fails, waits for this server's deploy slot before building here, ahead of the queue", async () => {
    await seed("d1", "a1", 30);
    await seed("d2", "a2", 20);
    const claimed = await q.claimDeploys("ex", { targets: await view() });
    await seed("d3", "a3", 10);

    const placed: (string | null)[] = [];
    const running = gate.withBuildSlot(
      gateFor("d2", q.claimedSlot("ex", claimed[1], 200), { targets: [longHouse] }),
      bounded,
      async ({ target }) => {
        placed.push(target?.id ?? null);
        if (target) throw new targets.BuilderError("it's unreachable");
      },
    );
    await sleep(600);
    expect(placed).toEqual(["mesh-lh"]);
    expect(await row("d2")).toMatchObject({ claim_slot: "target", wait_reason: "deploy-slot" });

    // The freed slot is owed to d2, not the queue.
    await finish("d1");
    expect(await q.claimDeploys("ex", { targets: await view() })).toEqual([]);
    await running;
    expect(placed).toEqual(["mesh-lh", null]);
    expect(await row("d2")).toMatchObject({ claim_slot: null, wait_reason: null });
    expect(await q.claimDeploys("ex", { targets: await view() })).toEqual([]);
  });

  it("puts a queued deploy that may build on a free target slot out of the deploy-slot line, and one that can't in it", async () => {
    await seed("d1", "a1", 30);
    await q.claimDeploys("ex", { targets: { slots: 0, holders: [], names: [] } });
    await seed("d2", "a2", 20);
    await seed("d3", "a3", 10);
    await sql`update deployment set claim_slot = 'local' where id = 'd2'`;

    const slots = await view();
    await w.markQueueWaits({ targets: slots, workerMissing: false });
    expect(await row("d2")).toMatchObject({ wait_reason: "deploy-slot" });
    expect(await row("d3")).toMatchObject({ wait_reason: null });
    expect((await sql`select wait_ahead, wait_total from deployment where id = 'd2'`)[0]).toEqual({ wait_ahead: 0, wait_total: 1 });

    // Without Long House, both wait for this server.
    await w.markQueueWaits({ targets: null, workerMissing: false });
    expect((await sql`select id, wait_reason, wait_ahead from deployment where status = 'queued' order by id`).map((r) => [r.id, r.wait_reason, r.wait_ahead]))
      .toEqual([["d2", "deploy-slot", 0], ["d3", "deploy-slot", 1]]);
  });
});
