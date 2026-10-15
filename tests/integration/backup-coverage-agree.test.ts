// The nightly email and the attention list agree on what isn't backed up, against a scratch database seeded like Long House.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const conn = await connectScratchServer();

const NOW = Date.parse("2026-10-15T10:03:00Z");
const DAY = 86_400_000;
const nightly = (daysAgo: number) => new Date(NOW - daysAgo * DAY - 6 * 3_600_000);
const emptySkipLog = (vol: string, source: string) =>
  `[2026-10-15T03:57:58.872Z] Backing up volume ${vol} (strategy: tar)\n` +
  `[2026-10-15T03:57:59.199Z] Skipping volume ${vol}: ${source} is empty and has never been backed up with data`;

describe.skipIf(!conn)("backup coverage on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("backup_agree");
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('o1', 'Homelab', 'homelab')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'o1', 'tools', 'Tools')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name, status, backups_enabled)
      values ('paperless', 'o1', 'p1', 'paperless', 'paperless', 'active', true),
             ('ollama', 'o1', 'p1', 'ollama', 'ollama', 'active', false),
             ('samba', 'o1', 'p1', 'samba', 'samba', 'active', false),
             ('kuma', 'o1', 'p1', 'kuma', 'kuma', 'active', null)`;
    await sql`insert into volume (id, app_id, organization_id, name, mount_path, type, source, persistent, durability, backup_selection, backup_strategy)
      values ('v-consume', 'paperless', 'o1', 'usr-src-paperless-consume', '/usr/src/paperless/consume', 'bind', '/mnt/docker/paperless/consume', false, null, 'include', 'tar'),
             ('v-export', 'paperless', 'o1', 'usr-src-paperless-export', '/usr/src/paperless/export', 'bind', '/mnt/docker/paperless/export', false, null, 'include', 'tar'),
             ('v-media', 'paperless', 'o1', 'usr-src-paperless-media', '/usr/src/paperless/media', 'bind', '/mnt/docker/paperless/media', false, null, 'include', 'tar'),
             ('v-ollama', 'ollama', 'o1', '/mnt/docker/ollama/data', '/root/.ollama', 'bind', '/mnt/docker/ollama/data', false, null, null, 'tar'),
             ('v-shares', 'samba', 'o1', 'shares', '/shares', 'named', null, true, null, 'include', 'tar'),
             ('v-kuma', 'kuma', 'o1', 'data', '/app/data', 'named', null, true, null, 'include', 'tar')`;
    await sql`insert into volume (id, app_id, organization_id, name, mount_path, type, source, persistent, durability, backup_selection, backup_strategy, backup_spec)
      values ('v-pg', 'paperless', 'o1', 'postgres', '/var/lib/postgresql/data', 'bind', '/mnt/docker/paperless/postgres', false, 'stateful', 'include', 'dump',
              ${sql.json({ kind: "postgres", service: "paperless-db" })})`;
    await sql`insert into backup_target (id, organization_id, name, type, config) values ('t1', 'o1', 'R2', 'local', ${sql.json({ path: "/tmp" })})`;
    // The switch turned samba's own job off.
    await sql`insert into backup_job (id, organization_id, target_id, name, enabled)
      values ('j-paperless', 'o1', 't1', 'Auto: paperless', true), ('j-samba', 'o1', 't1', 'Auto: samba', false)`;
    await sql`insert into backup_job_app (backup_job_id, app_id) values ('j-paperless', 'paperless'), ('j-samba', 'samba')`;

    let n = 0;
    const row = async (vol: string, status: string, daysAgo: number, log: string | null = null) => {
      const at = nightly(daysAgo);
      await sql`insert into backup (id, organization_id, target_id, job_id, app_id, app_name, volume_name, status, started_at, finished_at, log)
        values (${`b${n++}`}, 'o1', 't1', 'j-paperless', 'paperless', 'paperless', ${vol}, ${status}, ${at}, ${at}, ${log})`;
    };
    for (let d = 0; d < 7; d++) {
      await row("postgres", "success", d);
      await row("usr-src-paperless-consume", "skipped", d, emptySkipLog("usr-src-paperless-consume", "/mnt/docker/paperless/consume"));
      await row("usr-src-paperless-export", "skipped", d, emptySkipLog("usr-src-paperless-export", "/mnt/docker/paperless/export"));
      await row("usr-src-paperless-media", "failed", d, "Backup failed: tar exited 2");
    }
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("leaves empty bind sources the engine skips out of the stale volumes", async () => {
    const { loadStaleVolumes } = await import("@/lib/backups/runs");
    expect(await loadStaleVolumes("o1", NOW)).toEqual([
      { appId: "paperless", appName: "paperless", volumeName: "usr-src-paperless-media", lastSuccessAt: null },
    ]);
  });

  it("leaves apps with backups switched off out of the uncovered list", async () => {
    const { listUncoveredApps } = await import("@/lib/backups/enroll");
    expect((await listUncoveredApps("o1", { measure: false })).map((a) => [a.name, a.status])).toEqual([["kuma", "uncovered"]]);
  });

  it("raises no backup condition for an app with backups switched off", async () => {
    const { clearAdvisoryCache, loadAdvisoryInputs } = await import("@/lib/docker/condition-inputs");
    clearAdvisoryCache();
    const inputs = await loadAdvisoryInputs(NOW);
    expect(inputs.get("ollama")?.backup).toBeNull();
    expect(inputs.get("samba")?.backup).toBeNull();
    expect(inputs.get("kuma")?.backup).toEqual({ hasVolumes: true, configured: false, lastRunAt: null });
    expect(inputs.get("paperless")?.backup).toMatchObject({ hasVolumes: true, configured: true });
  });
});
