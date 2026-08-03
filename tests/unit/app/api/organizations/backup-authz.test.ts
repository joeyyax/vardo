// Backup routes verify the org, then trusted ids straight off the request body.
// Foreign app ids let a job back a victim's volumes up to the caller's own
// bucket, and instance-level targets were writable — and their credentials
// readable — by any org member.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyOrgAccess,
  mockRequirePlugin,
  mockIsAppAdmin,
  appsFindMany,
  backupTargetsFindFirst,
  backupTargetsFindMany,
  mockInsert,
  mockUpdate,
  mockDelete,
  insertValues,
} = vi.hoisted(() => {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  return {
    mockVerifyOrgAccess: vi.fn(),
    mockRequirePlugin: vi.fn(),
    mockIsAppAdmin: vi.fn(),
    appsFindMany: vi.fn(),
    backupTargetsFindFirst: vi.fn(),
    backupTargetsFindMany: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
    insertValues,
  };
});

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: mockRequirePlugin }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: mockIsAppAdmin }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findMany: appsFindMany },
      backupTargets: {
        findFirst: backupTargetsFindFirst,
        findMany: backupTargetsFindMany,
      },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

const { POST: createJob } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/route"
);
const { PATCH: updateJob } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/jobs/[jobId]/route"
);
const { GET: listTargets } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/targets/route"
);
const { PATCH: updateTarget, DELETE: deleteTarget } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/targets/[targetId]/route"
);

const ORG_ID = "org-1";
const JOB_ID = "job-1";
const OWN_APP = "app-own";
const FOREIGN_APP = "app-foreign";
const APP_LEVEL_TARGET = "target-system";
const ORG_TARGET = "target-org";

const S3_CONFIG = {
  bucket: "vardo-system",
  region: "us-east-1",
  endpoint: "https://s3.amazonaws.com",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "super-secret",
  prefix: "backups/",
};

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/organizations/${ORG_ID}/backups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePlugin.mockResolvedValue(null);
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role: "owner" },
  });
  mockIsAppAdmin.mockResolvedValue(false);
  backupTargetsFindFirst.mockResolvedValue({ id: ORG_TARGET, organizationId: ORG_ID });
  // An org-scoped lookup only ever returns the org's own app.
  appsFindMany.mockResolvedValue([{ id: OWN_APP }]);
  insertValues.mockResolvedValue(undefined);
  mockInsert.mockReturnValue({
    values: vi.fn((rows) => {
      insertValues(rows);
      return { returning: vi.fn().mockResolvedValue([{ id: JOB_ID }]) };
    }),
  });
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: ORG_TARGET }]),
      }),
    }),
  });
  mockDelete.mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: ORG_TARGET }]),
    }),
  });
});

describe("POST /organizations/[orgId]/backups — app ownership", () => {
  const params = { params: Promise.resolve({ orgId: ORG_ID }) };

  it("rejects an app id from another org", async () => {
    appsFindMany.mockResolvedValue([]); // org-scoped lookup finds nothing

    const res = await createJob(
      post({ name: "Nightly", targetId: ORG_TARGET, appIds: [FOREIGN_APP] }),
      params,
    );

    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a mix of owned and foreign app ids", async () => {
    const res = await createJob(
      post({ name: "Nightly", targetId: ORG_TARGET, appIds: [OWN_APP, FOREIGN_APP] }),
      params,
    );

    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("creates the job when every app belongs to the org", async () => {
    const res = await createJob(
      post({ name: "Nightly", targetId: ORG_TARGET, appIds: [OWN_APP] }),
      params,
    );

    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenLastCalledWith([
      { backupJobId: expect.any(String), appId: OWN_APP },
    ]);
  });
});

describe("PATCH /organizations/[orgId]/backups/jobs/[jobId] — app ownership", () => {
  const params = { params: Promise.resolve({ orgId: ORG_ID, jobId: JOB_ID }) };
  const url = `http://localhost/api/v1/organizations/${ORG_ID}/backups/jobs/${JOB_ID}`;

  it("rejects an app id from another org", async () => {
    appsFindMany.mockResolvedValue([]); // org-scoped lookup finds nothing

    const res = await updateJob(patch(url, { appIds: [FOREIGN_APP] }), params);

    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a target belonging to another org", async () => {
    backupTargetsFindFirst.mockResolvedValue(undefined);

    const res = await updateJob(patch(url, { targetId: "target-foreign" }), params);

    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("updates associations when every app belongs to the org", async () => {
    const res = await updateJob(patch(url, { appIds: [OWN_APP] }), params);

    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith([{ backupJobId: JOB_ID, appId: OWN_APP }]);
  });
});

describe("GET /organizations/[orgId]/backups/targets — credential disclosure", () => {
  const params = { params: Promise.resolve({ orgId: ORG_ID }) };

  function request() {
    return new NextRequest(
      `http://localhost/api/v1/organizations/${ORG_ID}/backups/targets`,
    );
  }

  beforeEach(() => {
    backupTargetsFindMany.mockResolvedValue([
      {
        id: APP_LEVEL_TARGET,
        organizationId: null,
        name: "System storage",
        type: "s3",
        config: S3_CONFIG,
        isDefault: true,
      },
      {
        id: "target-ssh",
        organizationId: null,
        name: "System SSH",
        type: "ssh",
        config: {
          host: "backups.example.com",
          username: "backup",
          path: "/var/backups",
          privateKey: "-----BEGIN PRIVATE KEY-----",
        },
        isDefault: false,
      },
      {
        id: ORG_TARGET,
        organizationId: ORG_ID,
        name: "Our bucket",
        type: "s3",
        config: { ...S3_CONFIG, bucket: "org-bucket" },
        isDefault: false,
      },
    ]);
  });

  it("strips credentials from app-level targets for org members", async () => {
    const res = await listTargets(request(), params);
    const { targets } = await res.json();

    const s3 = targets.find((t: { id: string }) => t.id === APP_LEVEL_TARGET);
    expect(s3.config.accessKeyId).toBeUndefined();
    expect(s3.config.secretAccessKey).toBeUndefined();

    const ssh = targets.find((t: { id: string }) => t.id === "target-ssh");
    expect(ssh.config.privateKey).toBeUndefined();

    const appLevel = targets.filter((t: { isAppLevel: boolean }) => t.isAppLevel);
    expect(JSON.stringify(appLevel)).not.toContain("super-secret");
    expect(JSON.stringify(appLevel)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("keeps the fields the target cards render", async () => {
    const res = await listTargets(request(), params);
    const { targets } = await res.json();

    const s3 = targets.find((t: { id: string }) => t.id === APP_LEVEL_TARGET);
    expect(s3).toMatchObject({
      name: "System storage",
      type: "s3",
      isAppLevel: true,
      config: { region: "us-east-1", endpoint: "https://s3.amazonaws.com" },
    });

    const ssh = targets.find((t: { id: string }) => t.id === "target-ssh");
    expect(ssh.config).toMatchObject({
      host: "backups.example.com",
      username: "backup",
      path: "/var/backups",
    });
  });

  it("returns the org's own target config untouched", async () => {
    const res = await listTargets(request(), params);
    const { targets } = await res.json();

    const own = targets.find((t: { id: string }) => t.id === ORG_TARGET);
    expect(own.config.secretAccessKey).toBe("super-secret");
    expect(own.isAppLevel).toBe(false);
  });

  it("returns the full app-level config to app admins", async () => {
    mockIsAppAdmin.mockResolvedValue(true);

    const res = await listTargets(request(), params);
    const { targets } = await res.json();

    const s3 = targets.find((t: { id: string }) => t.id === APP_LEVEL_TARGET);
    expect(s3.config.secretAccessKey).toBe("super-secret");
  });
});

describe("PATCH/DELETE /organizations/[orgId]/backups/targets/[targetId]", () => {
  const appLevelParams = {
    params: Promise.resolve({ orgId: ORG_ID, targetId: APP_LEVEL_TARGET }),
  };
  const orgParams = {
    params: Promise.resolve({ orgId: ORG_ID, targetId: ORG_TARGET }),
  };
  const appLevelUrl = `http://localhost/api/v1/organizations/${ORG_ID}/backups/targets/${APP_LEVEL_TARGET}`;
  const orgUrl = `http://localhost/api/v1/organizations/${ORG_ID}/backups/targets/${ORG_TARGET}`;

  function del(url: string) {
    return new NextRequest(url, { method: "DELETE" });
  }

  it("blocks an org member repointing an instance-level target", async () => {
    backupTargetsFindFirst.mockResolvedValue({
      id: APP_LEVEL_TARGET,
      organizationId: null,
    });

    const res = await updateTarget(
      patch(appLevelUrl, { config: { bucket: "attacker", region: "us-east-1" } }),
      appLevelParams,
    );

    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("blocks an org member deleting an instance-level target", async () => {
    backupTargetsFindFirst.mockResolvedValue({
      id: APP_LEVEL_TARGET,
      organizationId: null,
    });

    const res = await deleteTarget(del(appLevelUrl), appLevelParams);

    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("lets an app admin update an instance-level target", async () => {
    backupTargetsFindFirst.mockResolvedValue({
      id: APP_LEVEL_TARGET,
      organizationId: null,
    });
    mockIsAppAdmin.mockResolvedValue(true);

    const res = await updateTarget(patch(appLevelUrl, { name: "Renamed" }), appLevelParams);

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("still lets the org update its own target", async () => {
    const res = await updateTarget(patch(orgUrl, { name: "Renamed" }), orgParams);

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("404s a target from another org", async () => {
    backupTargetsFindFirst.mockResolvedValue(undefined);

    const res = await deleteTarget(del(orgUrl), orgParams);

    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
