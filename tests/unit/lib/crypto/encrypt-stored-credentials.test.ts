// The startup step that encrypts credentials stored before encryption on write.

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "d".repeat(64);

const { db, targetRows, settingRows } = vi.hoisted(() => {
  const targetRows: { id: string; organizationId: string | null; config: Record<string, unknown> }[] = [];
  const settingRows: { key: string; value: string }[] = [];
  const db = {
    select: () => ({ from: async () => targetRows.map((r) => ({ ...r, config: { ...r.config } })) }),
    query: {
      systemSettings: {
        findFirst: vi.fn(async () => settingRows[0]),
      },
    },
    // Writes land on the row the test seeded; the where guard isn't modeled.
    update: vi.fn(() => ({
      set: (data: Record<string, unknown>) => ({
        where: () => {
          if ("config" in data) {
            const row = targetRows[db.__targetCursor++];
            row.config = data.config as Record<string, unknown>;
            return { returning: async () => [{ id: row.id }] };
          }
          settingRows[0].value = data.value as string;
          return Promise.resolve();
        },
      }),
    })),
    __targetCursor: 0,
  };
  return { db, targetRows, settingRows };
});

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/system-settings", () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { encrypt, decrypt, decryptSystem, isEncrypted } = await import("@/lib/crypto/encrypt");
const { canEncryptStoredCredentials, encryptStoredCredentials } = await import(
  "@/lib/crypto/encrypt-stored-credentials"
);

const REGISTRY = JSON.stringify({ "ghcr.io": { username: "u", password: "ghp_token" } });

function seed() {
  targetRows.length = 0;
  settingRows.length = 0;
  db.__targetCursor = 0;
  targetRows.push(
    { id: "plain-org", organizationId: "org-1", config: { bucket: "b", region: "r", accessKeyId: "AK", secretAccessKey: "SK" } },
    { id: "plain-system", organizationId: null, config: { host: "h", username: "u", path: "/p", privateKey: "PEM" } },
    { id: "local", organizationId: "org-1", config: { path: "/backups" } },
  );
  settingRows.push({ key: "registry_credentials", value: REGISTRY });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("encryptStoredCredentials", () => {
  it("encrypts plaintext target credentials under the owning key", async () => {
    const result = await encryptStoredCredentials();

    expect(result.targets).toBe(2);
    const [org, system, local] = targetRows;
    expect(decrypt(org.config.secretAccessKey as string, "org-1")).toBe("SK");
    expect(decrypt(org.config.accessKeyId as string, "org-1")).toBe("AK");
    expect(org.config.bucket).toBe("b");
    expect(decryptSystem(system.config.privateKey as string)).toBe("PEM");
    expect(local.config).toEqual({ path: "/backups" });
  });

  it("encrypts plaintext registry credentials", async () => {
    const result = await encryptStoredCredentials();

    expect(result.settings).toBe(1);
    expect(isEncrypted(settingRows[0].value)).toBe(true);
    expect(decryptSystem(settingRows[0].value)).toBe(REGISTRY);
  });

  it("leaves ciphertext alone on a rerun", async () => {
    await encryptStoredCredentials();
    const after = JSON.stringify({ targetRows, settingRows });
    db.__targetCursor = 0;
    db.update.mockClear();

    const rerun = await encryptStoredCredentials();

    expect(rerun).toEqual({ targets: 0, settings: 0 });
    expect(db.update).not.toHaveBeenCalled();
    expect(JSON.stringify({ targetRows, settingRows })).toBe(after);
  });

  it("encrypts only the fields still in plaintext", async () => {
    const sealed = encrypt("SK", "org-1");
    targetRows.splice(1);
    targetRows[0].config.secretAccessKey = sealed;

    await encryptStoredCredentials();

    expect(targetRows[0].config.secretAccessKey).toBe(sealed);
    expect(decrypt(targetRows[0].config.accessKeyId as string, "org-1")).toBe("AK");
  });
});

describe("canEncryptStoredCredentials", () => {
  const probe = { encrypted: 0, undecryptable: 0, samples: [] };

  it("runs only under a key this database trusts", () => {
    expect(canEncryptStoredCredentials({ status: { kind: "ok", fingerprint: "k1:x" }, probe })).toBe(true);
    expect(canEncryptStoredCredentials({ status: { kind: "mismatch", recorded: "k1:a", running: "k1:b" }, probe })).toBe(false);
    expect(canEncryptStoredCredentials({ status: { kind: "unrecorded", running: "k1:b" }, probe })).toBe(false);
    expect(canEncryptStoredCredentials({ status: { kind: "unconfigured" }, probe })).toBe(false);
    expect(
      canEncryptStoredCredentials({ status: { kind: "ok", fingerprint: "k1:x" }, probe: { ...probe, undecryptable: 1 } }),
    ).toBe(false);
    expect(canEncryptStoredCredentials(null)).toBe(false);
  });
});
