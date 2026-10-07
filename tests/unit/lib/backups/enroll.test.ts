// #874: an app got backup coverage only through the backups:ensure-auto-backup
// hook, which ships unregistered. Enrollment now runs directly. No hook is
// registered anywhere in this file.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const { state, featureEnabled, execMock } = vi.hoisted(() => ({
  state: {
    volumes: [] as Row[],
    links: [] as { appId: string; backupJob: { organizationId: string | null } }[],
    target: undefined as Row | undefined,
    jobs: [] as (Row & { backupJobApps: { appId: string }[] })[],
    inserted: [] as { table: string; values: Row }[],
  },
  featureEnabled: vi.fn(),
  execMock: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  inArray: (_col: unknown, ids: string[]) => ({ ids }),
  and: (...parts: unknown[]) => ({ and: parts }),
}));

function idsOf(cond: unknown): string[] {
  const c = cond as { ids?: string[]; and?: unknown[] };
  return c.ids ?? (c.and ?? []).flatMap(idsOf);
}

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const tableName = (t: unknown) =>
    t === schema.backupJobs ? "backupJobs" : t === schema.backupJobApps ? "backupJobApps" : "volumes";
  const db = {
    query: {
      volumes: { findMany: async () => state.volumes },
      backupJobApps: { findMany: async () => state.links },
      backupTargets: { findFirst: async () => state.target },
      backupJobs: { findMany: async () => state.jobs },
    },
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [] }) }) }),
    update: () => ({
      set: (values: Row) => ({
        where: async (cond: unknown) => {
          for (const v of state.volumes) if (idsOf(cond).includes(v.id)) Object.assign(v, values);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        state.inserted.push({ table: tableName(table), values });
        return { onConflictDoNothing: async () => undefined, then: (r: (v: unknown) => void) => r(undefined) };
      },
    }),
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
  };
  return { db };
});
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: featureEnabled }));
vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execMock }));
vi.mock("fs/promises", () => ({ readFile: async () => { throw new Error("no host proc"); } }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/system-settings", () => ({ getBackupStorageConfig: vi.fn() }));

import { enrollNewApp, optInApp } from "@/lib/backups/enroll";

const APP = { appId: "app-1", appName: "notes", organizationId: "org-1" };

function volume(over: Partial<Row> = {}): Row {
  return {
    id: "vol-1",
    appId: "app-1",
    name: "data",
    mountPath: "/data",
    type: "named",
    source: null,
    persistent: true,
    durability: null,
    backupStrategy: "tar",
    backupSelection: null,
    ...over,
  };
}

const jobsCreated = () => state.inserted.filter((i) => i.table === "backupJobs").map((i) => i.values);
const linksCreated = () => state.inserted.filter((i) => i.table === "backupJobApps").map((i) => i.values);

beforeEach(() => {
  state.volumes = [];
  state.links = [];
  state.jobs = [];
  state.inserted = [];
  state.target = { id: "tgt-r2", organizationId: "org-1" };
  featureEnabled.mockReset().mockResolvedValue(true);
  execMock.mockReset().mockResolvedValue({ stdout: "1024\t/data\n", stderr: "" });
});

describe("enrollNewApp", () => {
  it("covers a new app with a named volume without any hook", async () => {
    state.volumes = [volume()];

    const result = await enrollNewApp(APP);

    expect(result.status).toBe("covered");
    expect(jobsCreated()).toEqual([
      expect.objectContaining({ name: "Auto: notes", targetId: "tgt-r2", organizationId: "org-1" }),
    ]);
    expect(linksCreated()).toEqual([expect.objectContaining({ appId: "app-1" })]);
    expect(state.volumes[0].backupSelection).toBe("include");
  });

  it("covers an app-owned bind, which the engine now captures", async () => {
    state.volumes = [volume({ type: "bind", source: "/mnt/docker/notes/data", persistent: false })];

    expect((await enrollNewApp(APP)).status).toBe("covered");
    expect(state.volumes[0].backupSelection).toBe("include");
  });

  it("does nothing when the backups feature is off", async () => {
    featureEnabled.mockResolvedValue(false);
    state.volumes = [volume()];

    expect(await enrollNewApp(APP)).toEqual({ status: "disabled" });
    expect(state.inserted).toEqual([]);
  });

  it("reports no target and creates no job", async () => {
    state.target = undefined;
    state.volumes = [volume()];

    expect(await enrollNewApp(APP)).toEqual({ status: "no-target" });
    expect(jobsCreated()).toEqual([]);
  });

  it("does not enroll an app whose only mounts are the host's", async () => {
    state.volumes = [
      volume({ id: "sock", type: "bind", source: "/var/run/docker.sock", persistent: false }),
      volume({ id: "tz", type: "bind", source: "/etc/localtime", persistent: false }),
    ];

    expect(await enrollNewApp(APP)).toEqual({ status: "nothing-to-back-up" });
    expect(state.inserted).toEqual([]);
  });

  it("keeps a volume over the size limit out while covering the rest", async () => {
    state.volumes = [
      volume({ id: "config", type: "bind", source: "/mnt/docker/notes/config", persistent: false }),
      volume({ id: "models", type: "bind", source: "/mnt/docker/notes/data", mountPath: "/root/.data", persistent: false }),
    ];
    execMock.mockImplementation(async (_cmd: string, args: string[]) => ({
      stdout: args.some((a) => a.startsWith("/mnt/docker/notes/data")) ? `${163 * 1024 ** 3}\t/data` : "2048\t/data",
      stderr: "",
    }));

    expect((await enrollNewApp({ ...APP, measure: true })).status).toBe("covered");
    expect(state.volumes.find((v) => v.id === "config")?.backupSelection).toBe("include");
    expect(state.volumes.find((v) => v.id === "models")?.backupSelection).toBe("exclude");
  });
});

describe("optInApp", () => {
  it("uses the chosen target", async () => {
    state.volumes = [volume()];

    const { jobId } = await optInApp({ ...APP, targetId: "tgt-nas" });

    expect(jobsCreated()).toEqual([expect.objectContaining({ id: jobId, targetId: "tgt-nas" })]);
  });

  it("reuses the app's Auto job on that target", async () => {
    state.volumes = [volume()];
    state.jobs = [{ id: "job-existing", name: "Auto: notes", backupJobApps: [] }];

    const { jobId } = await optInApp({ ...APP, targetId: "tgt-nas" });

    expect(jobId).toBe("job-existing");
    expect(jobsCreated()).toEqual([]);
    expect(linksCreated()).toEqual([{ backupJobId: "job-existing", appId: "app-1" }]);
  });

  it("includes exactly the volumes the admin chose", async () => {
    state.volumes = [
      volume({ id: "data" }),
      volume({ id: "big", name: "big", mountPath: "/big" }),
    ];

    const { included } = await optInApp({ ...APP, targetId: "tgt-r2", volumeIds: ["big"] });

    expect(included).toEqual(["big"]);
    expect(state.volumes.map((v) => [v.id, v.backupSelection])).toEqual([
      ["data", "exclude"],
      ["big", "include"],
    ]);
  });
});
