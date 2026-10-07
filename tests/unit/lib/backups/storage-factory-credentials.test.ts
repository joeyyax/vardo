// The backup engine builds storage through the factory, which hands each adapter
// plaintext credentials whatever form they're stored in.

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "c".repeat(64);

const { s3Configs, sshConfigs } = vi.hoisted(() => ({
  s3Configs: [] as unknown[],
  sshConfigs: [] as unknown[],
}));

vi.mock("@/lib/backups/storage-s3", () => ({
  S3BackupStorage: class {
    constructor(config: unknown) {
      s3Configs.push(config);
    }
  },
}));
vi.mock("@/lib/backups/storage-ssh", () => ({
  SshBackupStorage: class {
    constructor(config: unknown) {
      sshConfigs.push(config);
    }
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { encrypt, encryptSystem } = await import("@/lib/crypto/encrypt");
const { createBackupStorage } = await import("@/lib/backups/storage-factory");

const BASE = { bucket: "b", region: "auto" };

beforeEach(() => {
  s3Configs.length = 0;
  sshConfigs.length = 0;
});

describe("createBackupStorage credentials", () => {
  it("decrypts an org target's credentials", () => {
    createBackupStorage({
      name: "org",
      organizationId: "org-1",
      type: "r2",
      config: { ...BASE, accessKeyId: encrypt("AK", "org-1"), secretAccessKey: encrypt("SK", "org-1") },
    });
    expect(s3Configs[0]).toMatchObject({ accessKeyId: "AK", secretAccessKey: "SK" });
  });

  it("decrypts an instance target's credentials with the system key", () => {
    createBackupStorage({
      name: "system",
      organizationId: null,
      type: "s3",
      config: { ...BASE, accessKeyId: encryptSystem("AK"), secretAccessKey: encryptSystem("SK") },
    });
    expect(s3Configs[0]).toMatchObject({ accessKeyId: "AK", secretAccessKey: "SK" });
  });

  it("decrypts an SSH private key", () => {
    createBackupStorage({
      organizationId: "org-1",
      type: "ssh",
      config: { host: "h", username: "u", path: "/b", privateKey: encrypt("PEM", "org-1") },
    });
    expect(sshConfigs[0]).toMatchObject({ privateKey: "PEM" });
  });

  it("passes unmigrated plaintext through", () => {
    createBackupStorage({ organizationId: "org-1", type: "s3", config: { ...BASE, accessKeyId: "AK", secretAccessKey: "SK" } });
    expect(s3Configs[0]).toMatchObject({ accessKeyId: "AK", secretAccessKey: "SK" });
  });

  it("fails loudly rather than sending a credential the key can't open", () => {
    expect(() =>
      createBackupStorage({
        name: "Offsite",
        organizationId: "org-1",
        type: "s3",
        config: { ...BASE, accessKeyId: "AK", secretAccessKey: encrypt("SK", "another-org") },
      }),
    ).toThrow(/Offsite.*cannot be decrypted/);
    expect(s3Configs).toHaveLength(0);
  });
});
