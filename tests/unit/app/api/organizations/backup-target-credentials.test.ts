// Backup target credentials are encrypted at rest and never returned by the API,
// to members or admins (#809, #813 D4).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_MASTER_KEY ??= "b".repeat(64);

const {
  mockVerifyOrgAccess,
  mockIsAppAdmin,
  mockRequireAppAdmin,
  targetsFindFirst,
  targetsFindMany,
  jobsFindFirst,
  inserted,
  updated,
} = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockIsAppAdmin: vi.fn(),
  mockRequireAppAdmin: vi.fn(),
  targetsFindFirst: vi.fn(),
  targetsFindMany: vi.fn(),
  jobsFindFirst: vi.fn(),
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: mockIsAppAdmin, requireAppAdmin: mockRequireAppAdmin }));
vi.mock("@/lib/config/provider-restrictions", () => ({ isLocalBackupsAllowed: () => true }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupTargets: { findFirst: targetsFindFirst, findMany: targetsFindMany },
      backupJobs: { findFirst: jobsFindFirst },
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { returning: async () => [row] };
      },
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => {
        updated.push(data);
        return { where: () => ({ returning: async () => [{ ...currentTarget, ...data }] }) };
      },
    }),
  },
}));

const { encrypt, encryptSystem, decrypt, decryptSystem, isEncrypted } = await import("@/lib/crypto/encrypt");
const { GET: listTargets, POST: createTarget } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/targets/route"
);
const { PATCH: updateTarget } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/targets/[targetId]/route"
);
const { GET: listAdminTargets, POST: createAdminTarget } = await import(
  "@/app/api/v1/admin/backup-targets/route"
);
const { MASK_SENTINEL } = await import("@/lib/mask-secrets");

const ORG_ID = "org-1";
const ACCESS_KEY = "AKIAORGACCESSKEY";
const SECRET = "org-secret-access-key";
const SYSTEM_SECRET = "system-secret-access-key";
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

const S3 = { bucket: "org-bucket", region: "auto", endpoint: "https://r2.example.com" };

let currentTarget: Record<string, unknown> = {};

function json(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const orgParams = { params: Promise.resolve({ orgId: ORG_ID }) };
const targetUrl = `http://localhost/api/v1/organizations/${ORG_ID}/backups/targets`;

function storedTargets() {
  return [
    {
      id: "t-org",
      organizationId: ORG_ID,
      name: "Org bucket",
      type: "r2",
      config: { ...S3, accessKeyId: encrypt(ACCESS_KEY, ORG_ID), secretAccessKey: encrypt(SECRET, ORG_ID) },
      isDefault: true,
    },
    {
      // Written before encryption on write, not yet migrated.
      id: "t-legacy",
      organizationId: ORG_ID,
      name: "Legacy",
      type: "s3",
      config: { ...S3, accessKeyId: "AKIALEGACY", secretAccessKey: "legacy-plain-secret" },
      isDefault: false,
    },
    {
      id: "t-ssh",
      organizationId: ORG_ID,
      name: "Org SSH",
      type: "ssh",
      config: { host: "h", username: "u", path: "/b", privateKey: encrypt(PRIVATE_KEY, ORG_ID) },
      isDefault: false,
    },
    {
      id: "t-system",
      organizationId: null,
      name: "System default",
      type: "r2",
      config: { ...S3, accessKeyId: encryptSystem("AKIASYSTEM"), secretAccessKey: encryptSystem(SYSTEM_SECRET) },
      isDefault: true,
    },
  ];
}

const LEAKS = [ACCESS_KEY, SECRET, "AKIALEGACY", "legacy-plain-secret", "BEGIN OPENSSH", "AKIASYSTEM", SYSTEM_SECRET, "enc:v1:"];

function expectNoSecrets(body: unknown) {
  const text = JSON.stringify(body);
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID }, membership: { role: "member" } });
  mockIsAppAdmin.mockResolvedValue(false);
  mockRequireAppAdmin.mockResolvedValue(undefined);
  targetsFindMany.mockImplementation(async () => storedTargets());
});

describe("creating a target", () => {
  it("stores org credentials as ciphertext under the org key", async () => {
    const res = await createTarget(
      json(targetUrl, "POST", { name: "New", type: "r2", config: { ...S3, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET } }),
      orgParams,
    );
    expect(res.status).toBe(201);

    const config = inserted[0].config as Record<string, string>;
    expect(isEncrypted(config.secretAccessKey)).toBe(true);
    expect(isEncrypted(config.accessKeyId)).toBe(true);
    expect(decrypt(config.secretAccessKey, ORG_ID)).toBe(SECRET);
    expect(config.bucket).toBe("org-bucket");

    expectNoSecrets(await res.json());
  });

  it("stores an SSH private key as ciphertext", async () => {
    await createTarget(
      json(targetUrl, "POST", { name: "SSH", type: "ssh", config: { host: "h", username: "u", path: "/b", privateKey: PRIVATE_KEY } }),
      orgParams,
    );
    const config = inserted[0].config as Record<string, string>;
    expect(decrypt(config.privateKey, ORG_ID)).toBe(PRIVATE_KEY);
  });

  it("refuses a masked placeholder as a credential", async () => {
    const res = await createTarget(
      json(targetUrl, "POST", { name: "New", type: "r2", config: { ...S3, accessKeyId: ACCESS_KEY, secretAccessKey: MASK_SENTINEL } }),
      orgParams,
    );
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("stores instance credentials under the system key", async () => {
    const res = await createAdminTarget(
      json("http://localhost/api/v1/admin/backup-targets", "POST", {
        name: "System",
        type: "s3",
        config: { ...S3, accessKeyId: "AKIASYSTEM", secretAccessKey: SYSTEM_SECRET },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    const config = inserted[0].config as Record<string, string>;
    expect(decryptSystem(config.secretAccessKey)).toBe(SYSTEM_SECRET);
    expectNoSecrets(await res.json());
  });
});

describe("listing targets", () => {
  it("returns no credential to an org member", async () => {
    const res = await listTargets(new NextRequest(targetUrl), orgParams);
    const body = await res.json();
    expectNoSecrets(body);

    const org = body.targets.find((t: { id: string }) => t.id === "t-org");
    expect(org.config).toMatchObject({ bucket: "org-bucket", accessKeyId: MASK_SENTINEL, secretAccessKey: MASK_SENTINEL });
  });

  it("returns no credential to an instance admin", async () => {
    mockIsAppAdmin.mockResolvedValue(true);
    mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID }, membership: { role: "owner" } });

    expectNoSecrets(await (await listTargets(new NextRequest(targetUrl), orgParams)).json());
    expectNoSecrets(await (await listAdminTargets()).json());
  });
});

describe("editing a target", () => {
  const params = { params: Promise.resolve({ orgId: ORG_ID, targetId: "t-org" }) };
  const url = `${targetUrl}/t-org`;

  beforeEach(() => {
    currentTarget = storedTargets()[0];
    targetsFindFirst.mockResolvedValue(currentTarget);
  });

  it("keeps the stored credentials when the masked values come back", async () => {
    const stored = currentTarget.config as Record<string, string>;
    const res = await updateTarget(
      json(url, "PATCH", {
        name: "Renamed",
        config: { ...S3, bucket: "moved", accessKeyId: MASK_SENTINEL, secretAccessKey: MASK_SENTINEL },
      }),
      params,
    );
    expect(res.status).toBe(200);

    const config = updated[0].config as Record<string, string>;
    expect(config.bucket).toBe("moved");
    expect(config.secretAccessKey).toBe(stored.secretAccessKey);
    expect(decrypt(config.accessKeyId, ORG_ID)).toBe(ACCESS_KEY);
    expectNoSecrets(await res.json());
  });

  it("keeps the stored credentials when they're left out", async () => {
    await updateTarget(json(url, "PATCH", { config: { ...S3, bucket: "moved" } }), params);
    const config = updated[0].config as Record<string, string>;
    expect(decrypt(config.secretAccessKey, ORG_ID)).toBe(SECRET);
  });

  it("encrypts a replacement credential", async () => {
    await updateTarget(
      json(url, "PATCH", { config: { ...S3, accessKeyId: MASK_SENTINEL, secretAccessKey: "rotated-secret" } }),
      params,
    );
    const config = updated[0].config as Record<string, string>;
    expect(decrypt(config.secretAccessKey, ORG_ID)).toBe("rotated-secret");
  });

  it("encrypts a legacy plaintext credential it keeps", async () => {
    currentTarget = storedTargets()[1];
    targetsFindFirst.mockResolvedValue(currentTarget);

    await updateTarget(json(url, "PATCH", { config: { ...S3, accessKeyId: MASK_SENTINEL, secretAccessKey: MASK_SENTINEL } }), params);
    const config = updated[0].config as Record<string, string>;
    expect(decrypt(config.secretAccessKey, ORG_ID)).toBe("legacy-plain-secret");
  });

  it("rejects a config missing a required field", async () => {
    const res = await updateTarget(json(url, "PATCH", { config: { region: "auto" } }), params);
    expect(res.status).toBe(400);
    expect(updated).toHaveLength(0);
  });
});
