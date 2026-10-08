import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { encryptArchiveFile, readArchiveKeyId } from "@/lib/backups/archive-crypto";
import { fingerprintMasterKey } from "@/lib/crypto/key-fingerprint";
import { LocalBackupStorage } from "@/lib/backups/storage-local";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

const KEY = "a".repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vardo-restore-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readArchiveKeyId", () => {
  it("reads the Key ID an encrypted archive was written with", async () => {
    await writeFile(join(dir, "plain"), "x".repeat(5000));
    await encryptArchiveFile(join(dir, "plain"), join(dir, "sealed"), KEY);
    expect(await readArchiveKeyId(join(dir, "sealed"))).toBe(fingerprintMasterKey(KEY));
  });

  it("returns null for a plaintext archive", async () => {
    await writeFile(join(dir, "plain"), "x".repeat(5000));
    expect(await readArchiveKeyId(join(dir, "plain"))).toBeNull();
  });
});

describe("LocalBackupStorage.list", () => {
  it("lists keys under a prefix, recursively", async () => {
    await mkdir(join(dir, "vardo-system/postgres"), { recursive: true });
    await mkdir(join(dir, "acme/web"), { recursive: true });
    await writeFile(join(dir, "vardo-system/postgres/a.dump.gz"), "12345");
    await writeFile(join(dir, "acme/web/b.tar.gz"), "1");
    const storage = new LocalBackupStorage({ path: dir });
    const found = await storage.list("vardo-system/postgres/");
    expect(found.map((f) => [f.key, f.sizeBytes])).toEqual([["vardo-system/postgres/a.dump.gz", 5]]);
  });

  it("returns nothing for a prefix with no folder", async () => {
    expect(await new LocalBackupStorage({ path: dir }).list("nope/")).toEqual([]);
  });

  it("refuses a prefix outside the base path", async () => {
    await expect(new LocalBackupStorage({ path: dir }).list("../../etc/")).rejects.toThrow(/traversal/);
  });
});

describe("wrapSystemRestoreCmd", () => {
  it("clears the schema and restores in one transaction", async () => {
    const { wrapSystemRestoreCmd } = await import("@/lib/restore/database");
    const cmd = wrapSystemRestoreCmd("docker exec -i vardo-postgres psql -U host -v ON_ERROR_STOP=1 -d host");
    expect(cmd).toBe(
      "{ printf 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;\\n'; cat; } | docker exec -i vardo-postgres psql -U host -v ON_ERROR_STOP=1 --single-transaction -d host",
    );
  });
});

describe("databaseFailureReason", () => {
  it("surfaces psql's error over the command line", async () => {
    const { databaseFailureReason } = await import("@/lib/restore/database");
    const log = [
      "[2026-10-08T20:57:38.239Z] Restoring via: { printf ...",
      "drop cascades to table instance_restore",
      'ERROR:  relation "nowhere" does not exist',
      "[2026-10-08T20:57:38.300Z] Restore failed: Command failed: bash -c set -o pipefail; gunzip -c x | psql",
    ].join("\n");
    expect(databaseFailureReason(log)).toBe('Postgres refused the dump: relation "nowhere" does not exist');
  });

  it("keeps the engine's reason when psql never ran", async () => {
    const { databaseFailureReason } = await import("@/lib/restore/database");
    expect(
      databaseFailureReason("[t] Restore failed: Downloaded backup produced a 92-byte file — too small to be valid"),
    ).toBe("Downloaded backup produced a 92-byte file — too small to be valid");
  });
});
