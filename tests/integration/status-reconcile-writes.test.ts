// What the status reconcile writes for apps whose state didn't change, against a scratch database.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/docker/oom-watch", () => ({ tickOomWatch: async () => {} }));
vi.mock("@/lib/docker/client", () => ({
  listAllContainers: async () => [
    { id: "c-web", name: "web-1", image: "img", state: "running", status: "Up 2 hours", ports: [], labels: { "vardo.project.id": "web" } },
  ],
  inspectContainer: async (id: string) => ({
    id,
    name: "web-1",
    state: { running: true, status: "running", startedAt: "2026-10-01T00:00:00Z", finishedAt: "0001-01-01T00:00:00Z", exitCode: 0, oomKilled: false, health: null },
    restartCount: 0,
    createdAt: "2026-10-01T00:00:00Z",
    memoryBytes: 0,
    labels: {},
  }),
}));

const conn = await connectScratchServer();

describe.skipIf(!conn)("status reconcile on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("reconcile");
  let sql: ReturnType<typeof postgres>;
  let tickStatusReconcile: typeof import("@/lib/docker/status-reconcile").tickStatusReconcile;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 2, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`insert into organization (id, name, slug, trusted) values ('o1', 'Shop', 'shop', true)`;
      await t`insert into app (id, organization_id, name, display_name, project_id, status) values ('web', 'o1', 'web', 'Web', 'p1', 'stopped'), ('idle', 'o1', 'idle', 'Idle', 'p1', 'missing')`;
    });
    ({ tickStatusReconcile } = await import("@/lib/docker/status-reconcile"));
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("writes nothing for an unchanged idle app and only lastRunningAt for a running one", async () => {
    await tickStatusReconcile();
    const [first] = await sql`select status, last_running_at from app where id = 'web'`;
    expect(first.status).toBe("active");

    await new Promise((r) => setTimeout(r, 20));
    await tickStatusReconcile();
    const rows = await sql`select id, status, last_running_at, status_checked_at from app order by id`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.idle.status).toBe("missing");
    expect(byId.idle.status_checked_at).toBeNull();
    expect(byId.web.status_checked_at).toBeNull();
    expect(byId.web.last_running_at.getTime()).toBeGreaterThan(first.last_running_at.getTime());
  });
});
