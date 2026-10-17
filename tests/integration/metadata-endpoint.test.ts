// /v1/self end to end on Postgres: the caller's address picks the app, and nothing but that app's facts come back.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import type { RunningContainer } from "@/lib/metadata/caller";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const conn = await connectScratchServer();

const NOW = new Date();
const SECRET = "sk_live_DO_NOT_LEAK_51Hx";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NET_A = "vardo-p-p_a-production";
const NET_B = "vardo-p-p_b-production";

const proxy: RunningContainer = {
  Id: "proxy-id",
  Names: ["/vardo-metadata"],
  Labels: {},
  NetworkSettings: { Networks: { "vardo-metadata": { IPAddress: "172.30.0.2" }, [NET_A]: { IPAddress: "10.1.0.2" }, [NET_B]: { IPAddress: "10.2.0.2" } } },
};
const container = (id: string, appId: string, network: string, ip: string, service = "web"): RunningContainer => ({
  Id: id,
  Names: [`/${id}`],
  Labels: { "vardo.managed": "true", "vardo.project.id": appId, "vardo.environment": "production", "com.docker.compose.service": service },
  NetworkSettings: { Networks: { [network]: { IPAddress: ip } } },
});
const shopWeb = container("c-shop-web", "shop", NET_A, "10.1.0.5");
const blogWeb = container("c-blog-web", "blog", NET_B, "10.2.0.5");
// Claims to be the shop from the blog's project network.
const forged = container("c-forged", "shop", NET_B, "10.2.0.6");

function request(callerIp: string, localIp: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    "vardo-metadata": "1",
    "x-vardo-peer": "172.30.0.2",
    "x-vardo-caller": callerIp,
    "x-vardo-local": localIp,
    "x-vardo-request": "GET /v1/self HTTP/1.1",
    ...extra,
  });
}

describe.skipIf(!conn)("metadata endpoint on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("metadata_self");
  let sql: ReturnType<typeof postgres>;
  let handleSelf: typeof import("@/lib/metadata/handler").handleSelf;
  let deps: import("@/lib/metadata/handler").HandlerDeps;
  let clear: () => void;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('o1', 'Shop Co', 'shop-co'), ('o2', 'Blog Co', 'blog-co')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p_a', 'o1', 'store', 'Store'), ('p_b', 'o2', 'press', 'Press')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name, status, env_content, container_restart_count, container_restart_since)
      values ('shop', 'o1', 'p_a', 'shop', 'Shop', 'active', ${`STRIPE_KEY=${SECRET}`}, 2, ${new Date(NOW.getTime() - 86_400_000)}),
             ('blog', 'o2', 'p_b', 'blog', 'Blog', 'active', null, 0, null)`;
    await sql`insert into environment (id, app_id, name, type, is_default) values ('e_shop', 'shop', 'production', 'production', true), ('e_blog', 'blog', 'production', 'production', true)`;
    await sql`insert into env_var (id, app_id, key, value) values ('v1', 'shop', 'STRIPE_KEY', ${SECRET})`;
    const vars = (sha: string, name: string, id: string) => ({
      web: {
        VARDO_GIT_SHA: sha,
        VARDO_GIT_BRANCH: "main",
        VARDO_DEPLOY_ID: id,
        VARDO_DEPLOYED_AT: NOW.toISOString(),
        VARDO_APP_NAME: name,
        VARDO_ENVIRONMENT: "production",
        VARDO_APP_URL: `https://${name}.example.com`,
        VARDO_SLOT: "green",
      },
    });
    await sql`insert into deployment (id, app_id, status, trigger, git_sha, environment_id, slot, env_snapshot, config_snapshot, started_at)
      values ('d_shop', 'shop', 'success', 'manual', ${SHA_A}, 'e_shop', 'green', ${SECRET}, ${sql.json({ deployVars: vars(SHA_A, "shop", "d_shop"), env: SECRET } as never)}, ${NOW}),
             ('d_blog', 'blog', 'success', 'manual', ${SHA_B}, 'e_blog', 'green', null, ${sql.json({ deployVars: vars(SHA_B, "blog", "d_blog") } as never)}, ${NOW})`;
    await sql`insert into domain (id, app_id, domain) values ('dom_shop', 'shop', 'shop.example.com')`;
    await sql`insert into domain_cert_check (domain_id, expires_at, status) values ('dom_shop', ${new Date(NOW.getTime() + 40 * 86_400_000 + 3_600_000)}, 'ok')`;
    await sql`insert into backup_target (id, organization_id, name, type, config) values ('t1', 'o1', 'Local', 'local', ${sql.json({ path: "/tmp" })})`;
    await sql`insert into backup_job (id, organization_id, target_id, name, last_run_at, created_at) values ('j1', 'o1', 't1', 'Shop', ${NOW}, ${NOW})`;
    await sql`insert into backup_job_app (backup_job_id, app_id) values ('j1', 'shop')`;
    await sql`insert into backup (id, job_id, app_id, target_id, status, started_at, finished_at) values ('b1', 'j1', 'shop', 't1', 'success', ${NOW}, ${NOW})`;

    const handler = await import("@/lib/metadata/handler");
    const payload = await import("@/lib/metadata/payload");
    handleSelf = handler.handleSelf;
    clear = () => {
      payload.clearMetadataCache();
      handler.clearResolvedApps();
    };
    deps = {
      containers: async () => [proxy, shopWeb, blogWeb, forged],
      production: true,
      sources: {
        ...payload.dbSources,
        metrics: async (a) =>
          a.id === "shop"
            ? [{ containerId: "c-shop-web", containerName: "shop-web-1", cpuPercent: 12.5, memoryUsage: 200_000_000, memoryLimit: 536_870_912, memoryPercent: 37, labels: {}, timestamp: 0 } as never]
            : [],
        oomKills: async () => [],
      },
    };
  }, MIGRATE_TIMEOUT);

  beforeEach(() => clear?.());

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("returns the calling container's own app", async () => {
    const res = await handleSelf(request("10.1.0.5", "10.1.0.2"), deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      app: { id: "shop", name: "shop", service: "web", url: "https://shop.example.com" },
      environment: { name: "production", type: "production" },
      deploy: { id: "d_shop", sha: SHA_A, branch: "main", slot: "green" },
      resources: { container: { id: "c-shop-web", memoryUsedBytes: 200_000_000, memoryLimitBytes: 536_870_912, cpuPercent: 12.5 }, restarts: { count: 2 } },
      certs: [{ domain: "shop.example.com", daysLeft: 40, status: "ok" }],
      backups: { state: "ok", lastSuccessAt: NOW.toISOString() },
    });
  });

  it("never carries env values or snapshots", async () => {
    const res = await handleSelf(request("10.1.0.5", "10.1.0.2"), deps);
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("STRIPE_KEY");
  });

  it("gives another app's container that app's data, never this one's", async () => {
    const res = await handleSelf(request("10.2.0.5", "10.2.0.2"), deps);
    expect(res.status).toBe(200);
    expect(res.body?.app.id).toBe("blog");
    expect(JSON.stringify(res.body)).not.toContain(SHA_A);
    expect(JSON.stringify(res.body)).not.toContain("shop");
  });

  it("refuses a container labeled as this app on another project's network", async () => {
    expect(await handleSelf(request("10.2.0.6", "10.2.0.2"), deps)).toMatchObject({ status: 403 });
  });

  it("refuses a request without the header", async () => {
    const h = request("10.1.0.5", "10.1.0.2");
    h.delete("vardo-metadata");
    expect(await handleSelf(h, deps)).toMatchObject({ status: 400 });
  });

  it("refuses an unknown address", async () => {
    expect(await handleSelf(request("10.1.0.77", "10.1.0.2"), deps)).toMatchObject({ status: 403 });
  });

  it("refuses a request that didn't come through the proxy", async () => {
    expect(await handleSelf(request("10.1.0.5", "10.1.0.2", { "x-vardo-peer": "172.18.0.3" }), deps)).toMatchObject({ status: 403 });
  });

  it("answers 404 once the app turns it off", async () => {
    await sql`update app set metadata_endpoint = false where id = 'shop'`;
    try {
      expect(await handleSelf(request("10.1.0.5", "10.1.0.2"), deps)).toMatchObject({ status: 404 });
    } finally {
      await sql`update app set metadata_endpoint = true where id = 'shop'`;
    }
  });
});
