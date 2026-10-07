import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// #873: a transfer left the app linked to the source org's jobs, which skip it,
// so neither org backed it up. Accepting a transfer releases it from the source
// org's jobs and covers it in the destination.
//
// The fake keeps backup tables as rows and filters by the bound parameters of
// each where clause; ids are distinct across tables, so membership is enough.
// ---------------------------------------------------------------------------

const SRC = "org-src";
const DEST = "org-dest";

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  state: {
    transfer: null as Row | null,
    apps: [] as Row[],
    jobs: [] as Row[],
    links: [] as Row[],
    volumes: [] as Row[],
    targets: [] as Row[],
    history: [] as Row[],
    backupsOn: true,
  },
}));

vi.mock("@/lib/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const s = fake.state;
  const params = (where: unknown) => (where ? dialect.sqlToQuery(where as never).params : []);
  const has = (ps: unknown[], v: unknown) => ps.includes(v);
  const name = (t: unknown) => (t as { [k: symbol]: string })[Symbol.for("drizzle:Name")];

  const query = {
    appTransfers: { findFirst: async () => s.transfer },
    apps: {
      findFirst: async ({ where }: { where: unknown }) => s.apps.find((a) => has(params(where), a.id)),
      findMany: async ({ where, columns }: { where: unknown; columns?: Record<string, boolean> }) => {
        if (!columns?.id || columns.gitKeyId) return [];
        return s.apps.filter((a) => has(params(where), a.parentAppId));
      },
    },
    envVars: { findMany: async () => [] },
    deployments: { findMany: async () => [] },
    volumes: { findMany: async ({ where }: { where: unknown }) => s.volumes.filter((v) => has(params(where), v.appId)) },
    backupJobApps: {
      findMany: async ({ where }: { where: unknown }) =>
        s.links
          .filter((l) => has(params(where), l.appId))
          .map((l) => ({ ...l, backupJob: { organizationId: s.jobs.find((j) => j.id === l.backupJobId)!.organizationId } })),
    },
    backupTargets: {
      findFirst: async ({ where }: { where: unknown }) => {
        const ps = params(where);
        if (ps.length === 0) return s.targets.find((t) => t.organizationId === null);
        return s.targets.find((t) => t.organizationId === ps[0] && (ps.length < 2 || t.isDefault === ps[1]));
      },
    },
  };

  const update = (t: unknown) => ({
    set: (values: Row) => ({
      where: (where: unknown) => {
        const ps = params(where);
        if (name(t) === "backup") {
          for (const row of s.history) {
            if (!has(ps, row.appId)) continue;
            if ("jobId" in values) {
              if (!has(ps, row.jobId)) continue;
              row.jobName ??= s.jobs.find((j) => j.id === row.jobId)?.name;
              row.jobId = null;
            } else {
              Object.assign(row, values);
            }
          }
        }
        const p = Promise.resolve(undefined) as Promise<unknown> & { returning: () => Promise<unknown[]> };
        p.returning = async () => [{ id: "t-1" }];
        return p;
      },
    }),
  });

  const insert = (t: unknown) => ({
    values: (values: Row) => {
      if (name(t) === "backup_job") s.jobs.push(values);
      if (name(t) === "backup_job_app") s.links.push(values);
      const p = Promise.resolve(undefined) as Promise<unknown> & { onConflictDoUpdate: () => unknown };
      p.onConflictDoUpdate = () => ({ returning: async () => [{ id: "proj-dest" }] });
      return p;
    },
  });

  const del = (t: unknown) => ({
    where: (where: unknown) => ({
      returning: async () => {
        const ps = params(where);
        if (name(t) === "backup_job_app") {
          const gone = s.links.filter((l) => has(ps, l.appId) && has(ps, l.backupJobId));
          s.links = s.links.filter((l) => !gone.includes(l));
          return gone.map((l) => ({ jobId: l.backupJobId }));
        }
        if (name(t) === "backup_job") {
          const gone = s.jobs.filter((j) => has(ps, j.id) && !s.links.some((l) => l.backupJobId === j.id));
          s.jobs = s.jobs.filter((j) => !gone.includes(j));
          return gone.map((j) => ({ id: j.id }));
        }
        return [];
      },
    }),
  });

  const select = () => ({
    from: (t: unknown) => ({
      innerJoin: () => ({
        where: async () => [],
        innerJoin: () => ({
          where: async () =>
            s.links.flatMap((l) => {
              const job = s.jobs.find((j) => j.id === l.backupJobId)!;
              const app = s.apps.find((a) => a.id === l.appId);
              if (!app || job.organizationId === null || job.organizationId === app.organizationId) return [];
              return [{ jobOrgId: job.organizationId, appId: app.id, appName: app.name, appOrgId: app.organizationId }];
            }),
        }),
      }),
      where: async (where: unknown) =>
        name(t) === "backup_job" ? s.jobs.filter((j) => has(params(where), j.organizationId)) : [],
    }),
  });

  const tx = { query, update, insert, delete: del, select };
  return { db: { ...tx, transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } };
});

vi.mock("@/lib/config/features", () => ({
  isFeatureEnabledAsync: async () => fake.state.backupsOn,
}));

import { acceptTransfer } from "@/lib/transfers/engine";
import { repairForeignJobLinks } from "@/lib/backups/transfer";
import { evaluateConditions } from "@/lib/docker/conditions";

const linkedJobs = (appId: string) =>
  fake.state.links.filter((l) => l.appId === appId).map((l) => fake.state.jobs.find((j) => j.id === l.backupJobId)!);

describe("acceptTransfer backup coverage", () => {
  beforeEach(() => {
    const s = fake.state;
    s.transfer = { id: "t-1", appId: "app-1", sourceOrgId: SRC, destinationOrgId: DEST, status: "pending" };
    s.apps = [
      { id: "app-1", name: "web", parentAppId: null },
      { id: "child-1", name: "web-db", parentAppId: "app-1" },
    ];
    s.jobs = [
      { id: "job-auto", organizationId: SRC, name: "Auto: web", enabled: true },
      { id: "job-nightly", organizationId: SRC, name: "Nightly", enabled: true },
    ];
    s.links = [
      { backupJobId: "job-auto", appId: "app-1" },
      { backupJobId: "job-nightly", appId: "child-1" },
      { backupJobId: "job-nightly", appId: "other-app" },
    ];
    s.volumes = [{ id: "vol-1", appId: "app-1", persistent: true, durability: null }];
    s.targets = [{ id: "tgt-dest", organizationId: DEST, isDefault: true }];
    s.history = [
      { id: "b-1", appId: "app-1", jobId: "job-auto", jobName: null, organizationId: SRC },
      { id: "b-2", appId: "other-app", jobId: "job-nightly", jobName: "Nightly", organizationId: SRC },
    ];
    s.backupsOn = true;
  });

  it("removes the app and its compose children from every source org job", async () => {
    await acceptTransfer("t-1", "user-1");

    expect(linkedJobs("app-1").some((j) => j.organizationId === SRC)).toBe(false);
    expect(linkedJobs("child-1")).toEqual([]);
    expect(linkedJobs("other-app").map((j) => j.id)).toEqual(["job-nightly"]);
  });

  it("deletes the app's emptied auto job and keeps a job other apps still use", async () => {
    await acceptTransfer("t-1", "user-1");

    const ids = fake.state.jobs.map((j) => j.id);
    expect(ids).not.toContain("job-auto");
    expect(ids).toContain("job-nightly");
  });

  it("takes the app's history off the source jobs and keeps the job name", async () => {
    await acceptTransfer("t-1", "user-1");

    expect(fake.state.history.find((b) => b.id === "b-1")).toMatchObject({
      jobId: null,
      jobName: "Auto: web",
      organizationId: DEST,
    });
    expect(fake.state.history.find((b) => b.id === "b-2")).toMatchObject({ jobId: "job-nightly" });
  });

  it("covers the app with an auto job on the destination's default target", async () => {
    await acceptTransfer("t-1", "user-1");

    expect(linkedJobs("app-1")).toEqual([
      expect.objectContaining({ organizationId: DEST, targetId: "tgt-dest", name: "Auto: web" }),
    ]);
  });

  it("still accepts with no destination target and flags the app as not backed up", async () => {
    fake.state.targets = [];

    await expect(acceptTransfer("t-1", "user-1")).resolves.toBeUndefined();

    const configured = linkedJobs("app-1").some((j) => j.enabled);
    const { conditions } = evaluateConditions(
      {
        now: Date.now(),
        crashLoop: null,
        health: null,
        selfHealExhausted: false,
        memory: null,
        security: null,
        backup: { hasVolumes: true, configured, lastRunAt: null },
        cert: null,
      },
      [],
      {},
    );
    expect(conditions.map((c) => c.kind)).toContain("backup-missing");
  });

  it("leaves the destination alone when backups are off", async () => {
    fake.state.backupsOn = false;

    await acceptTransfer("t-1", "user-1");

    expect(linkedJobs("app-1")).toEqual([]);
  });
});

describe("repairForeignJobLinks", () => {
  it("releases an app transferred before #873 and covers it in its own org", async () => {
    const s = fake.state;
    s.apps = [{ id: "app-1", name: "web", parentAppId: null, organizationId: DEST }];
    s.jobs = [{ id: "job-auto", organizationId: SRC, name: "Auto: web", enabled: true }];
    s.links = [{ backupJobId: "job-auto", appId: "app-1" }];
    s.history = [];
    s.volumes = [{ id: "vol-1", appId: "app-1", persistent: true, durability: null }];
    s.targets = [{ id: "tgt-dest", organizationId: DEST, isDefault: true }];
    s.backupsOn = true;

    expect(await repairForeignJobLinks()).toBe(1);
    expect(s.jobs.map((j) => j.id)).not.toContain("job-auto");
    expect(linkedJobs("app-1")).toEqual([expect.objectContaining({ organizationId: DEST, name: "Auto: web" })]);
  });
});
