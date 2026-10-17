// A stopped app's backup job reads as on hold, a crashed one stays overdue, and a start resets the clock. Seeded like Long House.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const conn = await connectScratchServer();

const NOW = new Date("2026-10-17T10:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe.skipIf(!conn)("stopped apps' backup jobs on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("backup_stopped");
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug, time_zone) values ('o1', 'Long House', 'long-house', 'America/Los_Angeles')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'o1', 'home', 'Home')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name, status, parked, last_running_at, exit_reason)
      values ('lonvr', 'o1', 'p1', 'lonvr', 'Reeve NVR', 'missing', true, ${ago(76)}, null),
             ('restream', 'o1', 'p1', 'restream', 'Restream', 'stopped', false, ${ago(3)}, ${sql.json({ kind: "signal", signal: "SIGTERM", at: ago(3).toISOString() })}),
             ('fabric', 'o1', 'p1', 'fabric', 'fabric', 'missing', false, ${ago(41)}, null),
             ('web', 'o1', 'p1', 'web', 'Web', 'active', false, ${NOW}, null),
             ('wiki', 'o1', 'p1', 'wiki', 'Wiki', 'active', false, ${NOW}, null)`;
    await sql`insert into volume (id, app_id, organization_id, name, mount_path, type, persistent)
      values ('v-web', 'web', 'o1', 'data', '/data', 'named', true), ('v-loose', null, 'o1', 'postgres', '/var/lib/postgresql/data', 'named', true)`;
    await sql`insert into backup_target (id, organization_id, name, type, config) values ('t1', 'o1', 'R2', 'local', ${sql.json({ path: "/tmp" })})`;
    await sql`insert into backup_job (id, organization_id, target_id, name, last_run_at, created_at)
      values ('j-nvr', 'o1', 't1', 'Reeve NVR', ${ago(76)}, ${ago(200)}),
             ('j-restream', 'o1', 't1', 'Restream', ${ago(3)}, ${ago(200)}),
             ('j-fabric', 'o1', 't1', 'Auto: fabric', ${ago(41)}, ${ago(200)}),
             ('j-mixed', 'o1', 't1', 'Mixed', ${ago(10)}, ${ago(200)}),
             ('j-volume', 'o1', 't1', 'Web data', ${ago(10)}, ${ago(200)}),
             ('j-loose', 'o1', 't1', 'Loose', ${ago(10)}, ${ago(200)}),
             ('j-wiki', 'o1', 't1', 'Wiki', ${ago(10)}, ${ago(200)})`;
    await sql`insert into backup_job_app (backup_job_id, app_id)
      values ('j-nvr', 'lonvr'), ('j-restream', 'restream'), ('j-fabric', 'fabric'), ('j-mixed', 'lonvr'), ('j-mixed', 'web'), ('j-loose', 'lonvr'), ('j-wiki', 'wiki')`;
    await sql`insert into backup_job_volume (backup_job_id, volume_id) values ('j-volume', 'v-web'), ('j-loose', 'v-loose')`;
    // Wiki came back twelve hours ago after a stop.
    await sql`insert into activity (id, organization_id, app_id, action, created_at)
      values ('a1', 'o1', 'wiki', 'app.stopped', ${ago(20)}), ('a2', 'o1', 'wiki', 'app.started', ${new Date(NOW.getTime() - DAY / 2)})`;
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  async function staleness() {
    const { withJobApps } = await import("@/lib/backups/job-apps");
    const { backupJobStaleness } = await import("@/lib/backups/staleness");
    const jobs = await sql<{ id: string; name: string; schedule: string; enabled: boolean; lastRunAt: Date | null; createdAt: Date }[]>`
      select id, name, schedule, enabled, last_run_at as "lastRunAt", created_at as "createdAt" from backup_job order by id`;
    return backupJobStaleness(await withJobApps(jobs, NOW), NOW);
  }

  it("puts jobs whose apps were all stopped on purpose on hold and keeps the rest overdue", async () => {
    const { overdue, stopped } = await staleness();
    expect(stopped.map((s) => s.job.id)).toEqual(["j-nvr", "j-restream"]);
    expect(overdue.map((o) => [o.job.id, o.stoppedAppIds])).toEqual([
      ["j-fabric", []],
      ["j-loose", ["lonvr"]],
      ["j-mixed", ["lonvr"]],
      ["j-volume", []],
    ]);
  });

  it("raises no per-app backup condition for an app stopped outside Vardo, and keeps one for a vanished app", async () => {
    const { clearAdvisoryCache, loadAdvisoryInputs } = await import("@/lib/docker/condition-inputs");
    clearAdvisoryCache();
    const inputs = await loadAdvisoryInputs(NOW.getTime());
    expect(inputs.get("restream")?.backup).toBeNull();
    expect(inputs.get("lonvr")?.backup).toBeNull();
    expect(inputs.get("fabric")?.backup).toMatchObject({ configured: true });
  });

  it("counts a restarted app's job from its start", async () => {
    const { overdue, stopped } = await staleness();
    expect([...overdue, ...stopped].some((o) => o.job.id === "j-wiki")).toBe(false);
  });
});
