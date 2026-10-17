// Turning a domain off and on (#923) against a scratch database.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const conn = await connectScratchServer();

const APP = { id: "a1", organizationId: "o1", isSystemManaged: false };

describe.skipIf(!conn)("domain enabled flag on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("domainon");
  let sql: ReturnType<typeof postgres>;
  let manage: typeof import("@/lib/domains/manage");
  let splitRoutable: typeof import("@/lib/domains/routable").splitRoutable;
  let applyDeployTransforms: typeof import("@/lib/docker/compose-inject").applyDeployTransforms;
  let getFleetAttention: typeof import("@/lib/attention/fleet").getFleetAttention;
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let eq: typeof import("drizzle-orm").eq;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 2, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into organization (id, name, slug, trusted) values ('o1', 'Shop', 'shop', true)`;
      await t`insert into app (id, organization_id, name, display_name, project_id, status) values ('a1', 'o1', 'shop-web', 'Shop', 'p1', 'active')`;
    });
    manage = await import("@/lib/domains/manage");
    ({ splitRoutable } = await import("@/lib/domains/routable"));
    ({ applyDeployTransforms } = await import("@/lib/docker/compose-inject"));
    ({ getFleetAttention } = await import("@/lib/attention/fleet"));
    ({ db } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");
    ({ eq } = await import("drizzle-orm"));
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    await sql`delete from domain`;
    await sql`
      insert into domain (id, app_id, domain, is_primary, verified_at, compose_router)
      values ('d-www', 'a1', 'www.example.com', true, now(), null),
             ('d-shop', 'a1', 'shop.example.com', false, now(), null),
             ('d-dup', 'a1', 'old.example.com', false, now(), 'web')`;
  });

  /** Hosts with a router in the compose file the deploy would write. */
  async function routedHosts(): Promise<string[]> {
    const app = await db.query.apps.findFirst({
      where: eq(schema.apps.id, "a1"),
      with: { domains: { where: eq(schema.domains.source, "vardo") } },
    });
    const { routable } = await splitRoutable(app!.domains, { id: "o1", trusted: true });
    const compose = applyDeployTransforms(
      { services: { web: { name: "web", image: "nginx" } } },
      { appName: "shop-web", containerPort: 80, domains: routable, networkName: "vardo-network", orgTrusted: true },
    );
    const labels = Object.entries(compose.services.web.labels ?? {});
    return [...new Set(labels.filter(([k]) => /^traefik\.http\.routers\.[^.]+\.rule$/.test(k)).map(([, v]) => String(v).match(/Host\(`([^`]+)`\)/)?.[1]))]
      .filter((h): h is string => !!h)
      .sort();
  }

  it("drops a disabled domain's route and restores it when re-enabled", async () => {
    expect(await routedHosts()).toEqual(["old.example.com", "shop.example.com", "www.example.com"]);

    const off = await manage.editDomain(APP, { id: "d-shop", enabled: false });
    expect(off.ok).toBe(true);
    expect(await routedHosts()).toEqual(["old.example.com", "www.example.com"]);
    const [kept] = await sql`select enabled, verified_at from domain where id = 'd-shop'`;
    expect(kept.enabled).toBe(false);
    expect(kept.verified_at).not.toBeNull();
    const [app] = await sql`select needs_redeploy from app where id = 'a1'`;
    expect(app.needs_redeploy).toBe(true);

    expect((await manage.editDomain(APP, { id: "d-shop", enabled: true })).ok).toBe(true);
    expect(await routedHosts()).toEqual(["old.example.com", "shop.example.com", "www.example.com"]);
  });

  it("clears primary on disable and refuses a disabled domain as primary", async () => {
    expect((await manage.editDomain(APP, { id: "d-www", enabled: false })).ok).toBe(true);
    const [www] = await sql`select is_primary from domain where id = 'd-www'`;
    expect(www.is_primary).toBe(false);

    const refused = await manage.setPrimaryDomain(APP, "d-www");
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect((await manage.setPrimaryDomain(APP, "d-shop")).ok).toBe(true);
  });

  it("refuses to disable a domain the compose file also routes", async () => {
    const result = await manage.editDomain(APP, { id: "d-dup", enabled: false });
    expect(result).toMatchObject({ ok: false, status: 409 });
    const [row] = await sql`select enabled from domain where id = 'd-dup'`;
    expect(row.enabled).toBe(true);
  });

  it("lists a domain as unreachable once uptime confirms it, and drops it when disabled", async () => {
    await sql`insert into uptime_monitor (id, organization_id, name, "check", source, app_id, domain_id) values ('mon-shop', 'o1', 'shop.example.com', '{"type":"http","url":"https://shop.example.com","expectedStatus":{"min":100,"max":499},"timeoutMs":10000}', 'auto', 'a1', 'd-shop')`;
    const result = (ago: number) =>
      sql`insert into uptime_result (monitor_id, vantage_id, path, at, ok, latency_ms, error) values ('mon-shop', 'local', 'local', now() - ${ago}::int * interval '1 second', false, 10, 'timeout')`;
    await sql`insert into uptime_vantage (id, name, kind, public_key) values ('local', 'This instance', 'local', 'k') on conflict do nothing`;

    // One failure isn't confirmed.
    await result(30);
    expect((await getFleetAttention("o1")).unreachableDomains).toEqual([]);

    await result(10);
    expect((await getFleetAttention("o1")).unreachableDomains).toEqual([{ id: "d-shop", domain: "shop.example.com", appName: "shop-web", error: "timed out" }]);

    await manage.editDomain(APP, { id: "d-shop", enabled: false });
    expect((await getFleetAttention("o1")).unreachableDomains).toEqual([]);
  });
});
