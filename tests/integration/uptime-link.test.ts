// Two instances' uptime layers on two scratch Postgres databases, linked in process:
// B probes A's public monitors over the internet and delivers signed results, and A decides from them. Private monitors never reach B as checks.
// Each instance also watches the other as a peer.
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
  __tunnel?: (address: string) => unknown;
  vardoPgClient?: ReturnType<typeof postgres>;
};
const g = globalThis as G;

type Emitted = { orgId: string; type: string; title?: string; message?: string; subject?: string; alerts?: { title: string }[]; incident?: { state: string; subject?: { id: string } } };
const h = vi.hoisted(() => ({ emitted: [] as Emitted[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/activity/record", () => ({ recordActivity: async () => {} }));
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: Emitted) =>
    void h.emitted.push({ orgId, type: event.type, title: event.title, message: event.message, subject: event.subject, alerts: event.alerts, incident: event.incident }),
}));
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => [{ address: host === "intranet.example.com" ? "10.0.0.9" : "93.184.216.34", family: 4 }];
  return { lookup, default: { lookup } };
});
vi.mock("@/lib/uptime/outbound", async (orig) => ({
  ...(await orig<typeof import("@/lib/uptime/outbound")>()),
  checkDeps: async () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args), guard: async () => null }),
}));
vi.mock("@/lib/uptime/mesh-path", async (orig) => {
  const real = await orig<typeof import("@/lib/uptime/mesh-path")>();
  return {
    ...real,
    tunnelDeps: (address: string, ports: readonly number[]) => ((globalThis as G).__tunnel?.(address) ?? real.tunnelDeps(address, ports)) as ReturnType<typeof real.tunnelDeps>,
  };
});
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
  const notices = await import("@/lib/uptime/notices");
  const vantage = await import("@/lib/uptime/vantage");
  const core = await import("@/lib/uptime/core");
  return { engine, serve, prober, client, vantage, core, notices, pg: g.vardoPgClient!, sql: postgres(url, { max: 1, onnotice: () => {} }) };
}

const conn = await connectScratchServer();

describe.skipIf(!conn)("uptime between linked instances", { timeout: MIGRATE_TIMEOUT }, () => {
  let A: Boot;
  let B: Boot;
  let monitorId = "";
  let status = 200;
  let tunnelUp = true;
  const urls: string[] = [];
  const tunnelCalls: string[] = [];
  const org = { kind: "org", orgId: "org1" } as const;
  let t = Date.UTC(2026, 0, 10, 12, 0, 0);
  const at = () => t;
  /** Notifications that mention a monitor by name. */
  const about = (name: string) => h.emitted.filter((e) => `${e.title ?? ""} ${e.subject ?? ""} ${e.message ?? ""} ${(e.alerts ?? []).map((a) => a.title).join(" ")}`.includes(name));
  const shop = () => about("shop.example.com");
  const flushA = () => A.notices.flushNotices(t);
  /** A minute passes: A checks locally, B checks and delivers. */
  async function cycle(minutes = 1) {
    for (let i = 0; i < minutes; i++) {
      advance(60_000);
      await A.engine.runDueChecks(t, at);
      await asB(() => B.prober.probeDue(t, { now: at }));
      await asB(() => B.prober.deliverResults(t, true));
    }
  }
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
    // The tunnel: records who a check connected to and answers while it's up.
    g.__tunnel = (address: string) => ({
      fetch: async (input: string) => {
        tunnelCalls.push(`${address} ${new URL(String(input)).host}`);
        if (!tunnelUp) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        return new Response("ok", { status: 200 });
      },
      guard: async () => null,
      netConnect: () => {
        throw new Error("unused");
      },
      tlsConnect: () => {
        throw new Error("unused");
      },
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

    await B.sql`insert into organization (id, name, slug) values ('orgB', 'Org B', 'org-b')`;
    await A.sql`insert into organization (id, name, slug) values ('org1', 'Org', 'org')`;
    await A.sql`insert into project (id, organization_id, name, display_name) values ('proj1', 'org1', 'shop', 'Shop')`;
    await A.sql`insert into app (id, organization_id, project_id, name, display_name, status) values ('app1', 'org1', 'proj1', 'shop', 'Shop', 'active')`;
    await A.sql`insert into domain (id, app_id, domain, is_primary) values ('dom1', 'app1', 'shop.example.com', true)`;
    await A.engine.syncAutoMonitors();
    // The console shares the stubbed fetch; its outages aren't under test.
    await A.sql`update uptime_monitor set muted = true where id = 'mon_console'`;
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

  it("is degraded, without a notification, while only the local vantage point fails, and notifies once it is down and has held", async () => {
    status = 503;
    for (let i = 0; i < 2; i++) {
      advance(60_000);
      await A.engine.runDueChecks(t, at);
    }
    expect(await stateOnA()).toMatchObject({ state: "degraded", localOnly: false, reading: { kind: "local-only" } });
    expect(shop()).toEqual([]);

    // B agrees: both fail, so it's down. Nobody is told until it has held.
    await cycle(2);
    expect(await stateOnA()).toMatchObject({ state: "down", localOnly: false });
    await flushA();
    expect(shop()).toEqual([]);
    await cycle(3);
    await flushA();
    expect(shop()).toEqual([]);
    await cycle(1);
    await flushA();
    expect(shop().filter((e) => e.type === "system.service-down")).toEqual([
      expect.objectContaining({ title: "shop.example.com is down", subject: "shop.example.com is down", message: "shop.example.com isn't responding." }),
    ]);

    status = 200;
    await cycle(1);
    expect((await stateOnA()).state).toBe("up");
    await cycle(5);
    await flushA();
    expect(shop().some((e) => e.type === "alert.resolved")).toBe(true);
  });

  it("rejects a bad signature, an unknown vantage point and a monitor it doesn't watch", async () => {
    const { signRecord, resultBatch, generateKeyPair } = A.core;
    const result = { monitorId, vantageId: "inst-B", path: "public" as const, at: t, ok: false, latencyMs: 10 };
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
    const late = B.core.signRecord(B.core.resultBatch("inst-B", [{ monitorId, vantageId: "inst-B", path: "public" as const, at: t, ok: true, latencyMs: 5 }], t), key);
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

  describe("private monitors", () => {
    let privateId = "";

    it("never serves a monitor that resolves only to private addresses as a check", async () => {
      await A.sql`insert into domain (id, app_id, domain, is_primary) values ('dom2', 'app1', 'intranet.example.com', false)`;
      await A.engine.syncAutoMonitors();
      privateId = (await A.client.uptimeClient.listMonitors(org)).find((m) => m.target.includes("intranet"))!.id;

      await asB(() => B.prober.refreshWatchLists(t, true));
      expect((await B.sql`select monitor_id, path from uptime_watch_entry`).map((w) => `${w.monitor_id}:${w.path}`)).toEqual([`${monitorId}:public`]);
      const [vantage] = await A.sql`select watching from uptime_vantage where mesh_peer_id = 'peer-b-on-a'`;
      expect(vantage.watching).toEqual([monitorId]);

      tunnelCalls.length = 0;
      await bProbes(2);
      expect(tunnelCalls.filter((c) => c.endsWith("intranet.example.com"))).toEqual([]);
      expect(await B.sql`select 1 from uptime_probe_result where monitor_id = ${privateId}`).toHaveLength(0);
    });

    it("staggers the vantage points that share a monitor, each checking every interval x N", async () => {
      const period = async () => (await B.sql`select monitor_id, period_sec, offset_ms from uptime_watch_entry`) as unknown as { period_sec: number; offset_ms: number }[];
      await asB(() => B.prober.refreshWatchLists(t, true));
      expect((await period()).map((r) => r.period_sec)).toEqual([60]);

      await A.sql`update mesh_peer set status = 'online' where id = 'peer-b-on-a'`;
      await asB(() => B.prober.refreshWatchLists(t, true));
      const shared = await period();
      expect(shared.map((r) => r.period_sec)).toEqual([120]);
      // Sorted ids are ext_peer-b-on-a, then local: B takes the first slot of each period.
      expect(shared.every((r) => Number(r.offset_ms) < 60_000)).toBe(true);
      const local = A.core.staggerOf(monitorId, 60, ["local", "ext_peer-b-on-a"], "local");
      expect(local.periodSec).toBe(120);
      expect(local.offsetMs).toBeGreaterThanOrEqual(60_000);

      await A.sql`update mesh_peer set status = 'offline' where id = 'peer-b-on-a'`;
      await asB(() => B.prober.refreshWatchLists(t, true));
    });

    it("refuses a mesh result, for a public monitor or a private one", async () => {
      const { signRecord, resultBatch } = A.core;
      const key = await B.vantage.localSigningKey();
      const meshResult = (monitor: string) => signRecord(resultBatch("inst-B", [{ monitorId: monitor, vantageId: "inst-B", path: "mesh", at: t, ok: true, latencyMs: 5 }], t), key);
      expect((await A.serve.receiveRecords("peer-b-on-a", { records: [meshResult(monitorId)] }, t)).json).toMatchObject({ accepted: 0, rejected: [{ reason: "wrong path" }] });
      expect((await A.serve.receiveRecords("peer-b-on-a", { records: [meshResult(privateId)] }, t)).json).toMatchObject({ accepted: 0, rejected: [{ reason: "monitor not watched" }] });
    });
  });

  describe("instances watching each other", () => {
    const linkId = "mon_peer_link_peer-a-on-b";
    const peerEvents = () => h.emitted.filter((e) => e.orgId === "orgB" && e.incident?.subject?.id.startsWith(linkId));
    const openOn = async () =>
      (await B.sql`select subject_id, title, severity from incident where state = 'open' and subject_id like ${linkId + "%"}`) as unknown as {
        subject_id: string;
        title: string;
        severity: string;
      }[];
    async function bChecks(times = 2) {
      for (let i = 0; i < times; i++) {
        advance(60_000);
        await asB(() => B.engine.runDueChecks(t, at));
      }
    }

    it("creates a tunnel monitor and a public-URL monitor for the linked peer", async () => {
      await B.sql`update mesh_peer set public_api_url = 'https://a.example.com' where id = 'peer-a-on-b'`;
      await asB(() => B.engine.syncAutoMonitors());
      const rows = await B.sql`select id, peer_role, "check"->>'url' as url from uptime_monitor where mesh_peer_id = 'peer-a-on-b' order by peer_role`;
      expect(rows.map((r) => [r.id, r.peer_role, r.url])).toEqual([
        [linkId, "link", "http://10.99.0.2:3000/api/health"],
        ["mon_peer_pub_peer-a-on-b", "public", "https://a.example.com/api/health"],
      ]);
      expect(await B.client.uptimeClient.watchesPeer("peer-a-on-b")).toBe(true);
      expect(await B.client.uptimeClient.watchesPeer("nobody")).toBe(false);

      tunnelCalls.length = 0;
      await bChecks(2);
      expect(tunnelCalls.filter((c) => c.endsWith(":3000")).every((c) => c.startsWith("10.99.0.2 "))).toBe(true);
      expect(await openOn()).toEqual([]);
    });

    it("says the link is down once the tunnel has failed and stayed down, while the public URL answers", async () => {
      tunnelUp = false;
      status = 200;
      await bChecks(3);
      expect(await openOn()).toEqual([]);
      await bChecks(4);
      expect(await openOn()).toMatchObject([{ subject_id: `${linkId}#link-down`, title: "Link to inst-A is down", severity: "critical" }]);
    });

    it("moves to one 'down' alert when the public URL fails too, not two", async () => {
      status = 503;
      await bChecks(7);
      expect(await openOn()).toMatchObject([{ subject_id: `${linkId}#peer-down`, title: "inst-A is down" }]);
      expect(peerEvents().filter((e) => e.type === "system.service-down").map((e) => e.incident?.subject?.id)).toEqual([`${linkId}#link-down`, `${linkId}#peer-down`]);
      expect(await B.sql`select 1 from incident where kind = 'host.peer-silent' and state = 'open'`).toHaveLength(0);
    });

    it("says the peer is unreachable when it has no public URL", async () => {
      advance(31 * 60_000);
      await B.sql`update mesh_peer set public_api_url = null where id = 'peer-a-on-b'`;
      await asB(() => B.engine.syncAutoMonitors());
      expect(await B.sql`select 1 from uptime_monitor where id = 'mon_peer_pub_peer-a-on-b'`).toHaveLength(0);
      await bChecks(7);
      expect(await openOn()).toMatchObject([{ subject_id: `${linkId}#unreachable`, title: "inst-A unreachable from Vardo" }]);
    });

    it("resolves when the tunnel answers again", async () => {
      tunnelUp = true;
      status = 200;
      await bChecks(6);
      expect(await openOn()).toEqual([]);
      expect(peerEvents().some((e) => e.type === "alert.resolved")).toBe(true);
    });
  });

  it("shows B's signed hourly summary, then goes unknown once B stops delivering", async () => {
    t += 70 * 60_000;
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
