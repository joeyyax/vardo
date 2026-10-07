// #876: one backup switch per app, `app ?? org ?? system`. Off disables the
// app's own jobs and keeps its archives; on enrolls it through the selection
// rules on the default target.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Job = {
  id: string;
  enabled: boolean;
  organizationId: string | null;
  backupJobApps: { appId: string }[];
  backupJobVolumes: { volumeId: string }[];
};

const { state, enrollNewApp, featureEnabled } = vi.hoisted(() => ({
  state: {
    systemDefault: null as string | null,
    jobs: [] as Job[],
    apps: [] as Record<string, unknown>[],
    target: { id: "tgt-1" } as { id: string } | undefined,
    enabledWrites: [] as { ids: string[]; enabled: boolean }[],
  },
  enrollNewApp: vi.fn(),
  featureEnabled: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  inArray: (_col: unknown, ids: string[]) => ({ ids }),
  eq: (_col: unknown, value: string) => ({ ids: [value] }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupJobApps: {
        findMany: async ({ where }: { where: { ids: string[] } }) =>
          state.jobs
            .filter((j) => j.backupJobApps.some((a) => a.appId === where.ids[0]))
            .map((backupJob) => ({ backupJob })),
      },
      backupTargets: { findFirst: async () => state.target },
    },
    update: () => ({
      set: (values: { enabled: boolean }) => ({
        where: async (cond: { ids: string[] }) => {
          state.enabledWrites.push({ ids: cond.ids, enabled: values.enabled });
          for (const j of state.jobs) if (cond.ids.includes(j.id)) j.enabled = values.enabled;
        },
      }),
    }),
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => state.apps }) }) }),
  },
}));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: async () => state.systemDefault,
  setSystemSetting: vi.fn(async (_key: string, value: string) => {
    state.systemDefault = value;
  }),
  getBackupStorageConfig: vi.fn(),
}));
vi.mock("@/lib/backups/enroll", () => ({ enrollNewApp }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: featureEnabled }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  applyBackupSwitch,
  getAppBackupSwitchState,
  getSystemBackupsDefault,
  reconcileBackupSwitch,
  resolveBackupSwitch,
  setSystemBackupsDefault,
} from "@/lib/backups/switch";

const APP = { id: "app-1", name: "notes", organizationId: "org-1" };

function job(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    enabled: true,
    organizationId: "org-1",
    backupJobApps: [{ appId: "app-1" }],
    backupJobVolumes: [],
    ...over,
  };
}

beforeEach(() => {
  state.systemDefault = null;
  state.jobs = [];
  state.apps = [];
  state.target = { id: "tgt-1" };
  state.enabledWrites = [];
  enrollNewApp.mockReset().mockResolvedValue({ status: "covered", jobId: "job-new" });
  featureEnabled.mockReset().mockResolvedValue(true);
});

describe("resolveBackupSwitch", () => {
  it.each([
    [true, false, false, { enabled: true, source: "app" }],
    [false, true, true, { enabled: false, source: "app" }],
    [null, false, true, { enabled: false, source: "org" }],
    [null, true, false, { enabled: true, source: "org" }],
    [null, null, true, { enabled: true, source: "system" }],
    [undefined, undefined, false, { enabled: false, source: "system" }],
  ])("app %s, org %s, system %s", (app, org, system, expected) => {
    expect(resolveBackupSwitch(app, org, system)).toEqual(expected);
  });
});

describe("system default", () => {
  it("is on until an admin turns it off", async () => {
    expect(await getSystemBackupsDefault()).toBe(true);
    await setSystemBackupsDefault(false);
    expect(await getSystemBackupsDefault()).toBe(false);
    await setSystemBackupsDefault(true);
    expect(await getSystemBackupsDefault()).toBe(true);
  });
});

describe("applyBackupSwitch", () => {
  it("disables the app's own job when off and deletes nothing", async () => {
    state.jobs = [job()];

    expect(await applyBackupSwitch(APP, false)).toBe("disabled");
    expect(state.jobs[0].enabled).toBe(false);
  });

  it("leaves a job shared with other apps running", async () => {
    state.jobs = [job({ backupJobApps: [{ appId: "app-1" }, { appId: "app-2" }] })];

    expect(await applyBackupSwitch(APP, false)).toBe("unchanged");
    expect(state.jobs[0].enabled).toBe(true);
  });

  it("leaves a system job alone", async () => {
    state.jobs = [job({ organizationId: null })];

    expect(await applyBackupSwitch(APP, false)).toBe("unchanged");
    expect(state.enabledWrites).toEqual([]);
  });

  it("resumes a job it stopped when turned back on", async () => {
    state.jobs = [job({ enabled: false })];

    expect(await applyBackupSwitch(APP, true, { reenable: true })).toBe("enabled");
    expect(state.jobs[0].enabled).toBe(true);
    expect(enrollNewApp).not.toHaveBeenCalled();
  });

  it("leaves a disabled job alone without reenable", async () => {
    state.jobs = [job({ enabled: false })];

    expect(await applyBackupSwitch(APP, true)).toBe("unchanged");
    expect(state.jobs[0].enabled).toBe(false);
  });

  it("enrolls an app with no job through the measured enrollment path", async () => {
    expect(await applyBackupSwitch(APP, true)).toBe("enrolled");
    expect(enrollNewApp).toHaveBeenCalledWith({
      appId: "app-1",
      appName: "notes",
      organizationId: "org-1",
      measure: true,
    });
  });

  it("reports no target without failing", async () => {
    enrollNewApp.mockResolvedValue({ status: "no-target" });

    expect(await applyBackupSwitch(APP, true)).toBe("no-target");
  });
});

describe("getAppBackupSwitchState", () => {
  const row = { id: "app-1", organizationId: "org-1", backupsEnabled: null, orgBackupsEnabled: null };

  it("reports covered when an enabled job covers the app", async () => {
    state.jobs = [job()];

    expect(await getAppBackupSwitchState(row)).toMatchObject({
      enabled: true,
      source: "system",
      status: "covered",
    });
  });

  it("reports on with no target", async () => {
    state.target = undefined;

    expect(await getAppBackupSwitchState({ ...row, orgBackupsEnabled: true })).toMatchObject({
      enabled: true,
      source: "org",
      status: "no-target",
    });
  });

  it("reports off from the app's own setting", async () => {
    state.jobs = [job({ enabled: false })];

    expect(await getAppBackupSwitchState({ ...row, backupsEnabled: false })).toMatchObject({
      enabled: false,
      source: "app",
      setting: false,
      status: "off",
    });
  });
});

describe("reconcileBackupSwitch", () => {
  const app = (over: Record<string, unknown>) => ({
    id: "app-1",
    name: "notes",
    organizationId: "org-1",
    isSystemManaged: false,
    backupsEnabled: null,
    orgBackupsEnabled: null,
    ...over,
  });

  it("enrolls apps that resolve on and stops apps that resolve off", async () => {
    state.apps = [app({ id: "on-app" }), app({ id: "off-app", orgBackupsEnabled: false })];
    state.jobs = [job({ id: "job-off", backupJobApps: [{ appId: "off-app" }] })];

    const counts = await reconcileBackupSwitch();

    expect(enrollNewApp).toHaveBeenCalledWith(expect.objectContaining({ appId: "on-app" }));
    expect(state.jobs[0].enabled).toBe(false);
    expect(counts).toEqual({ enrolled: 1, disabled: 1 });
  });

  it("follows the system default for apps and orgs without a setting", async () => {
    state.systemDefault = "false";
    state.apps = [app({})];
    state.jobs = [job()];

    await reconcileBackupSwitch({ inheritOnly: true, orgInheritOnly: true });

    expect(state.jobs[0].enabled).toBe(false);
  });

  it("skips orgs with their own setting when only the system default changed", async () => {
    state.systemDefault = "false";
    state.apps = [app({ orgBackupsEnabled: true })];
    state.jobs = [job({ enabled: false })];

    expect(await reconcileBackupSwitch({ orgInheritOnly: true, reenable: true })).toEqual({});
    expect(state.jobs[0].enabled).toBe(false);
  });

  it("never touches Vardo's own apps", async () => {
    state.apps = [app({ name: "vardo", isSystemManaged: true })];

    expect(await reconcileBackupSwitch()).toEqual({});
    expect(enrollNewApp).not.toHaveBeenCalled();
  });

  it("does nothing while the backups feature is off", async () => {
    featureEnabled.mockResolvedValue(false);
    state.apps = [app({})];

    expect(await reconcileBackupSwitch()).toEqual({});
    expect(enrollNewApp).not.toHaveBeenCalled();
  });

  it("counts a failed app and carries on", async () => {
    state.apps = [app({ id: "bad" }), app({ id: "good" })];
    enrollNewApp.mockRejectedValueOnce(new Error("docker down"));

    expect(await reconcileBackupSwitch()).toEqual({ failed: 1, enrolled: 1 });
  });
});
