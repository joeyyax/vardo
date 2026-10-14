// A deleted app's archives and history, listed and deleted by the app's name (#936).
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const h = vi.hoisted(() => ({ role: "owner", members: new Set(["org1"]) }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn(async () => null) }));
vi.mock("@/lib/api/verify-access", async () => {
  const { gateOrgAccess } = await import("../unit/helpers/verify-access");
  return {
    verifyOrgAccess: gateOrgAccess(async (orgId: string) =>
      h.members.has(orgId) ? { organization: { id: orgId }, membership: { role: h.role } } : null,
    ),
  };
});

const conn = await connectScratchServer();

describe.skipIf(!conn)("a deleted app's history by name", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("deleted_app_history");
  const root = mkdtempSync(join(tmpdir(), "vardo-deleted-app-"));
  let sql: ReturnType<typeof postgres>;
  let route: typeof import("@/app/api/v1/organizations/[orgId]/backups/history/route");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('org1', 'One', 'one'), ('org2', 'Two', 'two')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'org1', 'proj', 'Proj')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name) values ('live-web', 'org1', 'p1', 'web', 'Web')`;
    await sql`insert into backup_target (id, organization_id, name, type, config)
      values ('t1', 'org1', 'Local', 'local', ${sql.json({ path: join(root, "org1") })}),
             ('t2', 'org2', 'Local', 'local', ${sql.json({ path: join(root, "org2") })})`;
    // A job the deleted app left behind: its rows keep the job id.
    await sql`insert into backup_job (id, organization_id, target_id, name) values ('job-cron', 'org1', 't1', 'Auto: cronlite')`;
    route = await import("@/app/api/v1/organizations/[orgId]/backups/history/route");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
    rmSync(root, { recursive: true, force: true });
  }, MIGRATE_TIMEOUT);

  type Row = {
    id: string;
    org: string;
    target: string;
    appId: string;
    appName: string;
    path: string | null;
    status?: string;
    size?: number;
    jobId?: string | null;
  };

  const archiveFile = (r: Row) => join(root, r.target === "t1" ? "org1" : "org2", r.path!);

  async function seed(rows: Row[]) {
    for (const r of rows) {
      await sql`insert into backup (id, organization_id, target_id, app_id, app_name, job_id, status, storage_path, size_bytes, volume_name)
        values (${r.id}, ${r.org}, ${r.target}, ${r.appId}, ${r.appName}, ${r.jobId ?? null}, ${r.status ?? "success"}, ${r.path}, ${r.size ?? 100}, 'data')`;
      if (r.path && (r.status ?? "success") === "success") {
        mkdirSync(dirname(archiveFile(r)), { recursive: true });
        writeFileSync(archiveFile(r), "archive");
      }
    }
  }

  const cronlite: Row[] = [
    { id: "c1", org: "org1", target: "t1", appId: "gone-cron", appName: "cronlite", path: "cron/a.tar.gz.age", jobId: "job-cron", size: 1000 },
    { id: "c2", org: "org1", target: "t1", appId: "gone-cron", appName: "cronlite", path: "cron/b.tar.gz.age", jobId: "job-cron", size: 2000 },
    { id: "c3", org: "org1", target: "t1", appId: "gone-cron", appName: "cronlite", path: "cron/old.tar.gz.enc", size: 500 },
    { id: "c4", org: "org1", target: "t1", appId: "gone-cron", appName: "cronlite", path: null, status: "failed" },
  ];
  const liveWeb: Row = { id: "w1", org: "org1", target: "t1", appId: "live-web", appName: "web", path: "web/live.tar.gz.age" };
  const goneWeb: Row = { id: "w2", org: "org1", target: "t1", appId: "gone-web", appName: "web", path: "web/old.tar.gz.age", size: 300 };
  const otherOrg: Row = { id: "x1", org: "org2", target: "t2", appId: "gone-cron-2", appName: "cronlite", path: "cron/a.tar.gz.age" };

  beforeEach(async () => {
    h.role = "owner";
    h.members = new Set(["org1"]);
    await sql`delete from backup`;
    rmSync(join(root, "org1"), { recursive: true, force: true });
    rmSync(join(root, "org2"), { recursive: true, force: true });
    await seed([...cronlite, liveWeb, goneWeb, otherOrg]);
  });

  const get = (orgId: string, query: Record<string, string> = {}) =>
    route.GET(jsonRequest("GET", `/api/v1/organizations/${orgId}/backups/history`, { query }), routeCtx({ orgId }));
  const del = (orgId: string, query: Record<string, string>) =>
    route.DELETE(jsonRequest("DELETE", `/api/v1/organizations/${orgId}/backups/history`, { query }), routeCtx({ orgId }));
  const remaining = async () => (await sql`select id from backup order by id`).map((r) => r.id);

  it("lists the org's deleted apps by name with their archives and bytes", async () => {
    const res = await get("org1");

    expect(res.status).toBe(200);
    const { apps } = await res.json();
    expect(apps).toEqual([
      { appName: "cronlite", appIds: ["gone-cron"], backups: 4, archives: 3, bytes: 3500 },
      { appName: "web", appIds: ["gone-web"], backups: 1, archives: 1, bytes: 300 },
    ]);
  });

  it("summarizes one deleted app by name, rows its job still points at included", async () => {
    const res = await get("org1", { appName: "cronlite" });

    expect(await res.json()).toEqual({ backups: 4, bytes: 3500 });
  });

  it("deletes the archives from storage, then the rows", async () => {
    const res = await del("org1", { appName: "cronlite" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 4, kept: 0, failed: [] });
    for (const r of cronlite.filter((r) => r.path)) expect(existsSync(archiveFile(r))).toBe(false);
    expect(await remaining()).toEqual(["w1", "w2", "x1"]);
  });

  it("never touches a live app's archives, even under the same name", async () => {
    const res = await del("org1", { appName: "web" });

    expect(await res.json()).toEqual({ deleted: 1, kept: 0, failed: [] });
    expect(existsSync(archiveFile(liveWeb))).toBe(true);
    expect(existsSync(archiveFile(goneWeb))).toBe(false);
    expect(await remaining()).toEqual(["c1", "c2", "c3", "c4", "w1", "x1"]);
  });

  it("leaves another org's history alone", async () => {
    await del("org1", { appName: "cronlite" });

    expect(existsSync(archiveFile(otherOrg))).toBe(true);
    expect(await remaining()).toContain("x1");
  });

  it("refuses an org the caller isn't a member of", async () => {
    const res = await del("org2", { appName: "cronlite" });

    expect(res.status).toBe(403);
    expect(existsSync(archiveFile(otherOrg))).toBe(true);
    expect(await remaining()).toContain("x1");
  });

  it("is for owners and admins", async () => {
    h.role = "member";

    const res = await del("org1", { appName: "cronlite" });

    expect(res.status).toBe(403);
    expect(await remaining()).toHaveLength(7);
  });

  it("keeps the row of each archive storage won't delete, and names it", async () => {
    // A directory where the archive should be: unlink fails.
    rmSync(archiveFile(cronlite[1]));
    mkdirSync(join(archiveFile(cronlite[1]), "stuck"), { recursive: true });

    const res = await del("org1", { appName: "cronlite" });

    const body = await res.json();
    expect(body).toMatchObject({ deleted: 3, kept: 1 });
    expect(body.failed).toEqual([expect.objectContaining({ id: "c2", volumeName: "data", error: expect.any(String) })]);
    expect(await remaining()).toEqual(["c2", "w1", "w2", "x1"]);
  });

  it("skips a backup still running", async () => {
    await seed([{ id: "c5", org: "org1", target: "t1", appId: "gone-cron", appName: "cronlite", path: null, status: "running" }]);

    const res = await del("org1", { appName: "cronlite" });

    expect(await res.json()).toMatchObject({ deleted: 4 });
    expect(await remaining()).toContain("c5");
  });

  it("refuses a delete with nothing to select by", async () => {
    const res = await del("org1", {});

    expect(res.status).toBe(400);
    expect(await remaining()).toHaveLength(7);
  });
});
