// Deploys queued behind a missing worker, per org and instance-wide, against a scratch database.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/worker/presence", () => ({ readWorkers: async () => ({ now: new Date(), rows: [] }) }));

const conn = await connectScratchServer();

describe.skipIf(!conn)("deploysWaitingForWorker on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("workerwait");
  let sql: ReturnType<typeof postgres>;
  let w: typeof import("@/lib/deploy/waiting");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    vi.stubEnv("NODE_ENV", "production");
    sql = postgres(url, { max: 2, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      for (const [id, org, name] of [["a1", "o1", "a1"], ["a2", "o1", "a2"], ["b1", "o2", "b1"], ["self", "o1", "vardo"]]) {
        await t`insert into app (id, organization_id, name, display_name, project_id) values (${id}, ${org}, ${name}, ${name}, 'p1')`;
      }
      for (const [id, app, status] of [["d1", "a1", "queued"], ["d2", "a2", "queued"], ["d3", "a2", "running"], ["d4", "b1", "queued"], ["d5", "self", "queued"]]) {
        await t`insert into deployment (id, app_id, trigger, status) values (${id}, ${app}, 'manual', ${status})`;
      }
    });
    w = await import("@/lib/deploy/waiting");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("counts one org's queued deploys, or every org's, never Vardo's own", async () => {
    expect(await w.deploysWaitingForWorker("o1")).toBe(2);
    expect(await w.deploysWaitingForWorker("o2")).toBe(1);
    expect(await w.deploysWaitingForWorker()).toBe(3);
  });
});
