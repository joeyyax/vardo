// Two instances' uptime layers on two scratch Postgres databases, linked in process:
// B probes A's monitor over the "public path", delivers signed results, and A decides from them.
// Skips without a Postgres it can create databases on.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

type Boot = Awaited<ReturnType<typeof boot>>;
type G = typeof globalThis & {
  __loading?: string;
  __caller?: string;
  __instances?: Record<string, Boot>;
  __routes?: Record<string, { to: string; asPeer: string }>;
  vardoPgClient?: ReturnType<typeof postgres>;
};
const g = globalThis as G;

const h = vi.hoisted(() => ({ emitted: [] as { orgId: string; type: string; incident?: { state: string; subject?: { id: string } } }[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/activity/record", () => ({ recordActivity: async () => {} }));
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: { type: string; incident?: { state: string; subject?: { id: string } } }) =>
    void h.emitted.push({ orgId, type: event.type, incident: event.incident }),
}));
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => [{ address: host === "intranet.example.com" ? "10.0.0.9" : "93.184.216.34", family: 4 }];
  return { lookup, default: { lookup } };
});
vi.mock("@/lib/uptime/outbound", async (orig) => ({
  ...(await orig<typeof import("@/lib/uptime/outbound")>()),
  checkDeps: async () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args), guard: async () => null }),
}));
vi.mock("@/lib/uptime/identity", async () => {
  return {
    localIdentity: async () => {
      const me = (globalThis as G).__caller!;
      const { ensureLocalVantage } = (globalThis as G).__instances![me].vantage;
      return { id: `inst-${me}`, name: `Instance ${me}`, location: `Hetzner Online · ${me === "B" ? "hel1" : "fsn1"}`, publicKey: (await ensureLocalVantage()).publicKey };
    },
  };
});
vi.mock("@/lib/mesh/client", async () => {
  class MeshClientError extends Error {
    constructor(
      message: string,
      public code: string,
      public statusCode?: number,
    ) {
      super(message);
    }
  }
  return {
    MeshClientError,
    meshSignedPost: async (peerId: string, path: string, payload: unknown) => {
      const route = (globalThis as G).__routes![peerId];
      const target = (globalThis as G).__instances![route.to];
      const body = JSON.parse(JSON.stringify(payload));
      const caller = (globalThis as G).__caller;
      (globalThis as G).__caller = route.to;
      let reply;
      try {
        reply = path.endsWith("/watch") ? await target.serve.serveWatchList(route.asPeer, body) : await target.serve.receiveRecords(route.asPeer, body);
      } finally {
        (globalThis as G).__caller = caller;
      }
      if (reply.status >= 400) throw new MeshClientError((reply.json as { error: string }).error, "PEER_ERROR", reply.status);
      return { data: reply.json, transport: "public" };
    },
  };
});

async function boot(name: string, url: string) {
  process.env.DATABASE_URL = url;
  process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
  g.vardoPgClient = undefined;
  g.__loading = name;
  vi.resetModules();
  const engine = await import("@/lib/uptime/engine");
  const serve = await import("@/lib/uptime/serve");
  const prober = await import("@/lib/uptime/prober");
  const client = await import("@/lib/uptime/client");
  const vantage = await import("@/lib/uptime/vantage");
  const core = await import("@/lib/uptime/core");
  return { engine, serve, prober, client, vantage, core, pg: g.vardoPgClient!, sql: postgres(url, { max: 1, onnotice: () => {} }) };
}

const conn = await connectScratchServer();

describe.skipIf(!conn)("uptime between linked instances", { timeout: MIGRATE_TIMEOUT }, () => {
  let A: Boot;
  let B: Boot;
  let monitorId = "";
  let status = 200;
  const urls: string[] = [];
  const org = { kind: "org", orgId: "org1" } as const;
  let t = Date.UTC(2026, 0, 10, 12, 0, 0);
  const at = () => t;
  const shop = () => h.emitted.filter((e) => e.incident?.subject?.id === monitorId);
  const stateOnA = async () => (await A.client.uptimeClient.listMonitors(org)).find((m) => m.id === monitorId)!;

  async function asB<T>(fn: () => Promise<T>): Promise<T> {
    g.__caller = "B";
    try {
      return await fn();
    } finally {
      g.__caller = "A";
    }
  }
  const advance = (ms: number) => {
    t += ms;
    vi.setSystemTime(t);
  };
  async function bProbes(minutes = 1) {
    for (let i = 0; i < minutes; i++) {
      advance(60_000);
      await asB(() => B.prober.probeDue(t, { now: at }));
      await asB(() => B.prober.deliverResults(t, true));
    }
  }

  beforeAll(async () => {
    const [urlA, urlB] = [await conn!.create(scratchName("uptime_a")), await conn!.create(scratchName("uptime_b"))];
    expect((await runMigrate(urlA)).code).toBe(0);
    expect((await runMigrate(urlB)).code).toBe(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t);
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response("ok", { status });
    });
    A = await boot("A", urlA);
    B = await boot("B", urlB);
    g.__instances = { A, B };
    g.__routes = { "peer-b-on-a": { to: "B", asPeer: "peer-a-on-b" }, "peer-a-on-b": { to: "A", asPeer: "peer-b-on-a" } };
    g.__caller = "A";

    const peer = (sql: Boot["sql"], id: string, instance: string, ip: string) =>
      sql`insert into mesh_peer (id, instance_id, name, public_key, allowed_ips, internal_ip, connection_type) values (${id}, ${instance}, ${instance}, ${id + "-key"}, '10.99.0.0/32', ${ip}, 'direct')`;
    await peer(A.sql, "peer-b-on-a", "inst-B", "10.99.0.2");
    await peer(A.sql, "peer-c-on-a", "inst-C", "10.99.0.3");
    await peer(B.sql, "peer-a-on-b", "inst-A", "10.99.0.2");

    await A.sql`insert into organization (id, name, slug) values ('org1', 'Org', 'org')`;
    await A.sql`insert into project (id, organization_id, name, display_name) values ('proj1', 'org1', 'shop', 'Shop')`;
    await A.sql`insert into app (id, organization_id, project_id, name, display_name, status) values ('app1', 'org1', 'proj1', 'shop', 'Shop', 'active')`;
    await A.sql`insert into domain (id, app_id, domain, is_primary) values ('dom1', 'app1', 'shop.example.com', true)`;
    await A.engine.syncAutoMonitors();
    monitorId = (await A.client.uptimeClient.listMonitors(org))[0].id;
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const i of [A, B]) {
      await i?.sql.end({ timeout: 1 });
      await i?.pg.end({ timeout: 1 });
    }
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("announces the vantage point and serves only public monitors", async () => {
    await asB(() => B.prober.refreshWatchLists(t, true));
      const watch = await B.sql`select monitor_id, interval_sec from uptime_watch_entry`;
    expect(watch.map((w) => w.monitor_id)).toEqual([monitorId]);

    const [vantage] = await A.sql`select * from uptime_vantage where mesh_peer_id = 'peer-b-on-a'`;
    expect(vantage).toMatchObject({ kind: "external", name: "Instance B", location: "Hetzner Online · hel1", remote_id: "inst-B", watching: [monitorId] });
    expect(vantage.private_key_encrypted).toBeNull();
  });

  it("marks a host that resolves to a private address unknown instead of checking it", async () => {
    await B.sql`insert into uptime_watch_entry (peer_id, monitor_id, "check", interval_sec, fetched_at) values
      ('peer-a-on-b', 'lan', '{"type":"http","url":"http://intranet.example.com/","expectedStatus":{"min":200,"max":399},"timeoutMs":5000}', 60, now())`;
    advance(60_000);
    await asB(() => B.prober.probeDue(t, { now: at }));
    const [row] = await B.sql`select ok, error, latency_ms from uptime_probe_result where monitor_id = 'lan'`;
    expect(row).toMatchObject({ ok: false, error: "private-address" });
    expect(urls.some((u) => u.includes("intranet"))).toBe(false);
    await B.sql`delete from uptime_watch_entry where monitor_id = 'lan'`;
    await B.sql`delete from uptime_probe_result where monitor_id = 'lan'`;
  });

  it("stores delivered results as received and takes the monitor's state from them", async () => {
    await bProbes(2);
    const monitor = await stateOnA();
    expect(monitor).toMatchObject({ state: "up", localOnly: false });

    const stored = await A.sql`select r.vantage_id, r.record_id, rec.sig, rec.payload from uptime_result r join uptime_record rec on rec.id = r.record_id`;
    expect(stored.length).toBe(3);
    expect(stored[0].vantage_id).toBe("ext_peer-b-on-a");
    const { verifyRecord } = A.core;
    const [vantage] = await A.sql`select public_key from uptime_vantage where id = 'ext_peer-b-on-a'`;
    expect(verifyRecord({ payload: stored[0].payload, sig: stored[0].sig }, vantage.public_key)).toMatchObject({ kind: "results" });
    const witness = await B.sql`select delivered_at from uptime_probe_result where monitor_id = ${monitorId}`;
    expect(witness.length).toBe(3);
    expect(witness.every((w) => w.delivered_at)).toBe(true);
  });

  it("stays up while only the local vantage point fails, and goes down when B agrees", async () => {
    status = 503;
    for (let i = 0; i < 2; i++) {
      advance(60_000);
      await A.engine.runDueChecks(t, at);
    }
    expect(await stateOnA()).toMatchObject({ state: "up", localOnly: false });
    expect(shop()).toEqual([]);

    await bProbes(1);
    expect((await stateOnA()).state).toBe("up");
    await bProbes(1);
    expect(await stateOnA()).toMatchObject({ state: "down", localOnly: false });
    expect(shop().filter((e) => e.type === "system.service-down")).toHaveLength(1);

    status = 200;
    await bProbes(1);
    expect((await stateOnA()).state).toBe("up");
    expect(shop().some((e) => e.type === "alert.resolved")).toBe(true);
  });

  it("rejects a bad signature, an unknown vantage point and a monitor it doesn't watch", async () => {
    const { signRecord, resultBatch, generateKeyPair } = A.core;
    const result = { monitorId, vantageId: "inst-B", at: t, ok: false, latencyMs: 10 };
    const before = (await A.sql`select count(*)::int as n from uptime_result`)[0].n;

    const forged = signRecord(resultBatch("inst-B", [result], t), generateKeyPair().privateKey);
    const bad = await A.serve.receiveRecords("peer-b-on-a", { records: [forged] });
    expect(bad.json).toMatchObject({ accepted: 0, rejected: [{ reason: "bad signature" }] });

    const key = await B.vantage.localSigningKey();
    const foreign = signRecord(resultBatch("inst-B", [{ ...result, monitorId: "mon_console" }], t), key);
    expect((await A.serve.receiveRecords("peer-b-on-a", { records: [foreign] })).json).toMatchObject({ accepted: 0, rejected: [{ reason: "monitor not watched" }] });

    const impostor = signRecord(resultBatch("inst-X", [{ ...result, vantageId: "inst-X" }], t), key);
    expect((await A.serve.receiveRecords("peer-b-on-a", { records: [impostor] })).json).toMatchObject({ accepted: 0 });

    const unknown = await A.serve.receiveRecords("peer-c-on-a", { records: [foreign] });
    expect(unknown).toMatchObject({ status: 403, json: { error: "Unknown vantage point" } });
    expect((await A.serve.receiveRecords("no-such-peer", { records: [foreign] })).status).toBe(403);

    expect((await A.sql`select count(*)::int as n from uptime_result`)[0].n).toBe(before);
  });

  it("honors the switch in each direction", async () => {
    await A.client.uptimeClient.setVantageLink("peer-b-on-a", { checksThisInstance: false });
    const refused = await A.serve.serveWatchList("peer-b-on-a", { vantage: { id: "inst-B", name: "B", location: null, publicKey: "x" } });
    expect(refused.status).toBe(403);
    await asB(() => B.prober.refreshWatchLists(t, true));
    expect((await B.sql`select 1 from uptime_watch_entry`).length).toBe(0);
    const key = await B.vantage.localSigningKey();
    const late = B.core.signRecord(B.core.resultBatch("inst-B", [{ monitorId, vantageId: "inst-B", at: t, ok: true, latencyMs: 5 }], t), key);
    expect((await A.serve.receiveRecords("peer-b-on-a", { records: [late] })).status).toBe(403);

    await A.client.uptimeClient.setVantageLink("peer-b-on-a", { checksThisInstance: true });
    await B.client.uptimeClient.setVantageLink("peer-a-on-b", { thisInstanceChecks: false });
    await asB(() => B.prober.refreshWatchLists(t, true));
    expect((await B.sql`select 1 from uptime_watch_entry`).length).toBe(0);
    const links = await B.client.uptimeClient.listVantageLinks();
    expect(links[0]).toMatchObject({ peerId: "peer-a-on-b", thisInstanceChecks: false, checksThisInstance: true });

    await B.client.uptimeClient.setVantageLink("peer-a-on-b", { thisInstanceChecks: true });
    await asB(() => B.prober.refreshWatchLists(t, true));
    expect((await B.sql`select 1 from uptime_watch_entry`).length).toBe(1);
  });

  it("shows B's signed hourly summary, then goes unknown once B stops delivering", async () => {
    t = Date.UTC(2026, 0, 10, 13, 30, 0);
    vi.setSystemTime(t);
    await asB(() => B.prober.signSummaries(t));
    await asB(() => B.prober.deliverResults(t, true));
    const detail = (await A.client.uptimeClient.getMonitor(org, monitorId))!;
    const external = detail.vantages.find((v) => v.kind === "external")!;
    expect(external).toMatchObject({ name: "Instance B", location: "Hetzner Online · hel1", state: "unknown" });
    expect(external.signedAt).toBeGreaterThan(0);

    expect(detail).toMatchObject({ state: "unknown", localOnly: true });
    status = 503;
    for (let i = 0; i < 2; i++) {
      advance(60_000);
      await A.engine.runDueChecks(t, at);
    }
    expect(await stateOnA()).toMatchObject({ state: "down", localOnly: true });
  });
});
