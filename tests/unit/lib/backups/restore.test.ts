// Round-trip restore coverage for the backup engine (#742). restoreBackup is a
// destructive operation — it wipes a volume / pipes into a DB restore — and had
// zero tests. These exercise the real checksum-verification guard (the
// data-loss prevention) and assert the correct restore command dispatches per
// strategy, with docker/bash/storage/db mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { copyFile } from "fs/promises";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { tmpdir } from "os";
import { join } from "path";

// BACKUPS_DIR is resolved from this env var at module load — point it at a real
// temp dir so the engine's tmp work (download target, checksum) is hermetic.
const BACKUPS_ROOT = mkdtempSync(join(tmpdir(), "vardo-restore-test-"));
process.env.VARDO_BACKUPS_DIR = BACKUPS_ROOT;

// A real archive whose bytes we control, so checksumFile() computes a real hash.
const SOURCE_ARCHIVE = join(BACKUPS_ROOT, "source.tar.gz");
const ARCHIVE_BYTES = Buffer.alloc(512, 7); // ≥100 bytes so verifyArchive passes
const REAL_CHECKSUM = `sha256:${createHash("sha256").update(ARCHIVE_BYTES).digest("hex")}`;

const {
  backupsFindFirst,
  volumesFindFirst,
  execFileMock,
  executeHooksMock,
  listContainersMock,
  inspectContainerMock,
  resolveDefaultEnvMock,
  probeDecryptabilityMock,
} = vi.hoisted(() => ({
  backupsFindFirst: vi.fn(),
  volumesFindFirst: vi.fn(),
  execFileMock: vi.fn((...args: unknown[]) => {
    // Callback-style for promisify(execFile): resolve success.
    const cb = args[args.length - 1];
    if (typeof cb === "function") (cb as (e: unknown, r: unknown) => void)(null, { stdout: "", stderr: "" });
  }),
  executeHooksMock: vi.fn().mockResolvedValue({ allowed: true, results: [] }),
  listContainersMock: vi.fn(),
  inspectContainerMock: vi.fn(),
  resolveDefaultEnvMock: vi.fn(),
  probeDecryptabilityMock: vi.fn(),
}));

// Default execFile impl: every docker/bash call succeeds. Re-applied in
// beforeEach so a per-test override (e.g. failing `volume inspect`) can't leak.
const execSuccess = (...args: unknown[]) => {
  const cb = args[args.length - 1];
  if (typeof cb === "function") (cb as (e: unknown, r: unknown) => void)(null, { stdout: "", stderr: "" });
};

vi.mock("@/lib/db", () => ({
  db: { query: { backups: { findFirst: backupsFindFirst }, volumes: { findFirst: volumesFindFirst } } },
}));
// Only execFile is stubbed — the swap tests run the real restore script via spawnSync.
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: execFileMock,
}));
vi.mock("@/lib/hooks/execute", () => ({ executeHooks: executeHooksMock }));
vi.mock("@/lib/docker/client", () => ({
  listContainers: listContainersMock,
  inspectContainer: inspectContainerMock,
}));
vi.mock("@/lib/docker/resolve-env", () => ({ resolveDefaultEnv: resolveDefaultEnvMock }));
vi.mock("@/lib/crypto/key-escrow", () => ({ probeDecryptability: probeDecryptabilityMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
// Storage download just copies our prepared source archive to the engine's tmp path.
vi.mock("@/lib/backups/storage-factory", () => ({
  createBackupStorage: () => ({
    upload: vi.fn(),
    delete: vi.fn(),
    download: vi.fn(async (_key: string, dest: string) => {
      await copyFile(SOURCE_ARCHIVE, dest);
    }),
  }),
}));

import { restoreBackup } from "@/lib/backups/engine";
import { buildTarRestoreScript } from "@/lib/backups/archive";

function backupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk-1",
    appId: "app-1",
    volumeName: "data",
    storagePath: "org/app/data/backup.tar.gz",
    strategy: "tar",
    checksum: REAL_CHECKSUM,
    target: { organizationId: "org-1" },
    app: { name: "myapp" },
    ...overrides,
  };
}

/** Did the engine reach an actual restore command (tar extract / dump pipe)? */
function restoreCommandRan(): boolean {
  return execFileMock.mock.calls.some((call) => {
    const [file, args] = call as [string, string[]];
    if (file === "docker" && Array.isArray(args) && args.includes("run")) return true; // tar restore
    if (file === "bash" && Array.isArray(args) && args.join(" ").includes("gunzip -c")) return true; // dump restore
    return false;
  });
}

beforeAll(() => {
  writeFileSync(SOURCE_ARCHIVE, ARCHIVE_BYTES);
});

afterAll(() => {
  rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(execSuccess);
  backupsFindFirst.mockReset();
  volumesFindFirst.mockReset();
  executeHooksMock.mockResolvedValue({ allowed: true, results: [] });
  // Default: no running container (resolver falls through to name derivation).
  listContainersMock.mockReset().mockResolvedValue([]);
  inspectContainerMock.mockReset().mockResolvedValue({ mounts: [] });
  resolveDefaultEnvMock.mockReset().mockResolvedValue({ name: "production", type: "production", id: "env-1" });
  probeDecryptabilityMock.mockReset().mockResolvedValue({ encrypted: 3, undecryptable: 0, samples: [] });
});

describe("restoreBackup — volume (tar) round-trip", () => {
  it("verifies the checksum and runs the tar extract into the docker volume", async () => {
    backupsFindFirst.mockResolvedValue(backupRow());
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(result.log).toMatch(/Checksum verified/);
    // The extract command ran against a -v <volume>:/data mount with tar xzf.
    const tarCall = execFileMock.mock.calls.find(
      ([file, args]) => file === "docker" && (args as string[]).includes("run"),
    );
    expect(tarCall).toBeDefined();
    expect((tarCall![1] as string[]).join(" ")).toMatch(/tar xzf "\/backup\/volume\.tar\.gz"/);
  });
});

describe("restoreBackup — database (dump) round-trip", () => {
  it("verifies the checksum and pipes the gunzipped dump into the restore command", async () => {
    backupsFindFirst.mockResolvedValue(
      backupRow({ strategy: "dump", storagePath: "org/app/data/backup.dump.gz" }),
    );
    volumesFindFirst.mockResolvedValue({
      backupStrategy: "dump",
      backupMeta: { dumpCmd: "pg_dump -U u db", restoreCmd: "docker exec -i pg psql -U u db" },
    });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    const bashCall = execFileMock.mock.calls.find(([file]) => file === "bash");
    expect(bashCall).toBeDefined();
    expect((bashCall![1] as string[]).join(" ")).toMatch(/gunzip -c .* \| docker exec -i pg psql -U u db/);
  });
});

describe("restoreBackup — corrupted/mismatched archive is rejected", () => {
  it("fails before running any restore command when the checksum doesn't match", async () => {
    backupsFindFirst.mockResolvedValue(backupRow({ checksum: `sha256:${"0".repeat(64)}` }));
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(false);
    expect(result.log).toMatch(/Checksum mismatch/);
    // The data-loss guarantee: no tar extract / dump pipe was ever executed.
    expect(restoreCommandRan()).toBe(false);
  });

  it("is blocked by a denying before.backup.restore hook", async () => {
    backupsFindFirst.mockResolvedValue(backupRow());
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null });
    executeHooksMock.mockResolvedValue({ allowed: false, blockedBy: { hookName: "guard" }, results: [] });

    await expect(restoreBackup("bk-1")).rejects.toThrow(/blocked by hook/i);
    expect(restoreCommandRan()).toBe(false);
  });
});

// Restoring Vardo's own database dump replaces every app's env vars with
// ciphertext from the source instance. Without that instance's master key the
// result is a complete, unreadable database — and the archive is the only thing
// that knows which key it belongs to.
describe("restoring the instance database is gated on the encryption key", () => {
  const HEX_KEY = "a".repeat(64);
  const systemDumpRow = (overrides: Record<string, unknown> = {}) =>
    backupRow({
      appId: null,
      app: null,
      volumeName: "postgres",
      strategy: "dump",
      storagePath: "vardo-system/postgres/backup.dump.gz",
      keyFingerprint: null,
      ...overrides,
    });
  const systemVolume = {
    backupStrategy: "dump",
    backupMeta: { dumpCmd: "pg_dump -U u db", restoreCmd: "docker exec -i pg psql -U u db" },
  };

  beforeEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  afterAll(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  it("refuses when the archive names a key this host does not have", async () => {
    process.env.ENCRYPTION_MASTER_KEY = HEX_KEY;
    backupsFindFirst.mockResolvedValue(systemDumpRow({ keyFingerprint: "k1:fedcba9876543210" }));
    volumesFindFirst.mockResolvedValue(systemVolume);

    await expect(restoreBackup("bk-1")).rejects.toThrow(/k1:fedcba9876543210/);
    expect(restoreCommandRan()).toBe(false);
  });

  it("restores anyway when the operator accepts losing the env vars", async () => {
    process.env.ENCRYPTION_MASTER_KEY = HEX_KEY;
    backupsFindFirst.mockResolvedValue(systemDumpRow({ keyFingerprint: "k1:fedcba9876543210" }));
    volumesFindFirst.mockResolvedValue(systemVolume);
    probeDecryptabilityMock.mockResolvedValue({ encrypted: 4, undecryptable: 4, samples: ["blog"] });

    const result = await restoreBackup("bk-1", { acceptKeyMismatch: true });

    expect(result.success).toBe(true);
    expect(result.log).toMatch(/4 of 4 restored encrypted values cannot be decrypted/);
  });

  it("proceeds when the archive names the running key", async () => {
    process.env.ENCRYPTION_MASTER_KEY = HEX_KEY;
    const { fingerprintMasterKey } = await import("@/lib/crypto/key-fingerprint");
    backupsFindFirst.mockResolvedValue(systemDumpRow({ keyFingerprint: fingerprintMasterKey(HEX_KEY) }));
    volumesFindFirst.mockResolvedValue(systemVolume);

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(restoreCommandRan()).toBe(true);
    expect(result.log).toMatch(/Verified 3 restored encrypted value\(s\)/);
  });

  it("restores an archive predating fingerprinting, and says the key is unconfirmed", async () => {
    process.env.ENCRYPTION_MASTER_KEY = HEX_KEY;
    backupsFindFirst.mockResolvedValue(systemDumpRow());
    volumesFindFirst.mockResolvedValue(systemVolume);

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(result.log).toMatch(/predates encryption key fingerprinting/);
  });

  it("leaves an app's own archive ungated", async () => {
    backupsFindFirst.mockResolvedValue(backupRow({ keyFingerprint: "k1:fedcba9876543210" }));
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(probeDecryptabilityMock).not.toHaveBeenCalled();
  });
});

// The archive format is fixed when the archive is written. Re-deriving it from
// the volume row at restore time flips the strategy whenever that row was
// edited, renamed or deleted since — and restoring a dump as a tar wipes the
// live volume before failing.
describe("restore strategy comes from the backup record, not current volume config", () => {
  it("restores a dump archive as a dump even when the volume row now says tar", async () => {
    backupsFindFirst.mockResolvedValue(
      backupRow({ strategy: "dump", storagePath: "org/app/data/backup.dump.gz" }),
    );
    volumesFindFirst.mockResolvedValue({
      backupStrategy: "tar",
      backupMeta: { dumpCmd: "pg_dump -U u db", restoreCmd: "docker exec -i pg psql -U u db" },
    });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    const bashCall = execFileMock.mock.calls.find(([file]) => file === "bash");
    expect((bashCall![1] as string[]).join(" ")).toMatch(/gunzip -c .* \| docker exec -i pg psql/);
    // Never touched the volume.
    expect(execFileMock.mock.calls.some(([file, args]) =>
      file === "docker" && (args as string[]).includes("run"))).toBe(false);
  });

  it("falls back to the storage path extension for rows written before the column", async () => {
    backupsFindFirst.mockResolvedValue(
      backupRow({ strategy: null, storagePath: "org/app/data/backup.dump.gz" }),
    );
    volumesFindFirst.mockResolvedValue({
      backupStrategy: "tar",
      backupMeta: { dumpCmd: "pg_dump -U u db", restoreCmd: "docker exec -i pg psql -U u db" },
    });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    expect(execFileMock.mock.calls.some(([file]) => file === "bash")).toBe(true);
  });

  it("does not wipe the volume when the volume row was deleted after the dump was taken", async () => {
    backupsFindFirst.mockResolvedValue(
      backupRow({ strategy: null, storagePath: "org/app/data/backup.dump.gz" }),
    );
    volumesFindFirst.mockResolvedValue(undefined); // row is gone

    const result = await restoreBackup("bk-1");

    // No restoreCmd to run, so it fails — but it must fail without destroying anything.
    expect(result.success).toBe(false);
    expect(result.log).toMatch(/restoreCmd/);
    expect(restoreCommandRan()).toBe(false);
  });

  it("refuses to restore an archive whose format cannot be determined", async () => {
    backupsFindFirst.mockResolvedValue(
      backupRow({ strategy: null, storagePath: "org/app/data/backup.bin" }),
    );
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null });

    await expect(restoreBackup("bk-1")).rejects.toThrow(/determine the archive format/i);
    expect(restoreCommandRan()).toBe(false);
  });
});

// The tar restore used to run `rm -rf /data/*` and the extract in one shell, so
// an unreadable or wrong-format archive emptied the live volume and then failed.
// These drive the real script against temp dirs standing in for the mounts.
describe("tar restore leaves the volume intact unless the extract succeeds", () => {
  function makeVolume(): { dataDir: string; backupDir: string } {
    const root = mkdtempSync(join(BACKUPS_ROOT, "swap-"));
    const dataDir = join(root, "data");
    const backupDir = join(root, "backup");
    mkdirSync(join(dataDir, "nested"), { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(dataDir, "live.txt"), "irreplaceable");
    writeFileSync(join(dataDir, ".hidden"), "also irreplaceable");
    writeFileSync(join(dataDir, "nested", "deep.txt"), "nested data");
    return { dataDir, backupDir };
  }

  function runScript(dataDir: string, backupDir: string) {
    return spawnSync("sh", ["-c", buildTarRestoreScript(dataDir, backupDir)], { encoding: "utf8" });
  }

  it("keeps every existing file when the archive is not a readable tar", () => {
    const { dataDir, backupDir } = makeVolume();
    // A valid gzip stream that is a pg dump, not a tar — exactly the wrong-strategy case.
    writeFileSync(join(backupDir, "volume.tar.gz"), gzipSync(Buffer.from("-- PostgreSQL dump\n")));

    const proc = runScript(dataDir, backupDir);

    expect(proc.status).not.toBe(0);
    expect(readFileSync(join(dataDir, "live.txt"), "utf8")).toBe("irreplaceable");
    expect(readFileSync(join(dataDir, ".hidden"), "utf8")).toBe("also irreplaceable");
    expect(readFileSync(join(dataDir, "nested", "deep.txt"), "utf8")).toBe("nested data");
    // No staging litter left behind.
    expect(readdirSync(dataDir).sort()).toEqual([".hidden", "live.txt", "nested"]);
  });

  it("replaces the volume contents with the archive when the extract succeeds", () => {
    const { dataDir, backupDir } = makeVolume();
    const src = mkdtempSync(join(BACKUPS_ROOT, "src-"));
    writeFileSync(join(src, "restored.txt"), "from backup");
    writeFileSync(join(src, ".dotfile"), "hidden from backup");
    expect(
      spawnSync("tar", ["czf", join(backupDir, "volume.tar.gz"), "-C", src, "."]).status,
    ).toBe(0);

    const proc = runScript(dataDir, backupDir);

    expect(proc.status).toBe(0);
    expect(readFileSync(join(dataDir, "restored.txt"), "utf8")).toBe("from backup");
    expect(readFileSync(join(dataDir, ".dotfile"), "utf8")).toBe("hidden from backup");
    // Files absent from the archive are gone, staging dir included.
    expect(readdirSync(dataDir).sort()).toEqual([".dotfile", "restored.txt"]);
  });
});

// #756: persistent volumes are env-scoped (`${app}-${env}_${vol}`), shared
// across blue/green slots. The resolver must target the volume the app actually
// uses — never a blue/green slot name the app would never mount.
describe("#756 — volume resolution targets the real env-scoped volume", () => {
  /** All docker volume args across every execFile call, flattened. */
  function allDockerArgs(): string[] {
    return execFileMock.mock.calls
      .filter(([file]) => file === "docker")
      .map(([, args]) => (args as string[]).join(" "));
  }

  it("restores into the volume Docker actually has mounted (env-scoped), not a slot name", async () => {
    backupsFindFirst.mockResolvedValue(backupRow({ appId: "app-1", volumeName: "data" }));
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null, mountPath: "/app/data" });
    listContainersMock.mockResolvedValue([{ id: "c1" }]);
    inspectContainerMock.mockResolvedValue({
      mounts: [{ type: "volume", name: "myapp-production_data", destination: "/app/data", source: "" }],
    });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    const runCall = execFileMock.mock.calls.find(
      ([file, args]) => file === "docker" && (args as string[]).includes("run"),
    );
    expect((runCall![1] as string[]).join(" ")).toContain("myapp-production_data:/data");
    // The data-integrity guarantee: never touch a blue/green slot volume.
    expect(allDockerArgs().some((a) => /-blue_|-green_/.test(a))).toBe(false);
  });

  // `vardo.project` is the app name for every environment and slot; only
  // `vardo.environment` separates them. An unscoped lookup lets a running
  // staging or preview container hand back its volume for a production restore.
  it("only inspects containers in the app's own environment", async () => {
    backupsFindFirst.mockResolvedValue(backupRow({ appId: "app-1", volumeName: "data" }));
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null, mountPath: "/app/data" });
    resolveDefaultEnvMock.mockResolvedValue({ name: "staging", type: "staging", id: "env-2" });
    listContainersMock.mockResolvedValue([{ id: "c1" }]);
    inspectContainerMock.mockResolvedValue({
      mounts: [{ type: "volume", name: "myapp-staging_data", destination: "/app/data", source: "" }],
    });

    await restoreBackup("bk-1");

    expect(listContainersMock).toHaveBeenCalledWith(
      { id: "app-1", name: "myapp" },
      "staging",
    );
  });

  it("ignores a container mount at a different path", async () => {
    backupsFindFirst.mockResolvedValue(backupRow({ appId: "app-1", volumeName: "data" }));
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null, mountPath: "/app/data" });
    listContainersMock.mockResolvedValue([{ id: "c1" }]);
    inspectContainerMock.mockResolvedValue({
      mounts: [{ type: "volume", name: "myapp-production_cache", destination: "/app/cache", source: "" }],
    });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    // No mount matched /app/data → derives env-scoped name, which inspect confirms.
    const runCall = execFileMock.mock.calls.find(
      ([file, args]) => file === "docker" && (args as string[]).includes("run"),
    );
    expect((runCall![1] as string[]).join(" ")).toContain("myapp-production_data:/data");
    expect((runCall![1] as string[]).join(" ")).not.toContain("myapp-production_cache");
  });

  it("creates the env-scoped volume (never a blue slot) when nothing exists yet", async () => {
    backupsFindFirst.mockResolvedValue(backupRow({ appId: "app-1", volumeName: "data" }));
    volumesFindFirst.mockResolvedValue({ backupStrategy: "tar", backupMeta: null, mountPath: "/app/data" });
    listContainersMock.mockResolvedValue([]); // no running container
    // Every `docker volume inspect` fails → resolver finds nothing → create path.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      const dockerArgs = args[1] as string[];
      if (Array.isArray(dockerArgs) && dockerArgs.includes("inspect")) {
        cb(new Error("no such volume"), null);
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });

    const result = await restoreBackup("bk-1");

    expect(result.success).toBe(true);
    const dockerArgs = allDockerArgs();
    expect(dockerArgs.some((a) => a.includes("volume create myapp-production_data"))).toBe(true);
    // It may *probe* slot names (read-only inspect), but must never create or
    // restore into one — that's the data-integrity guarantee.
    const mutating = dockerArgs.filter((a) => a.includes("volume create") || a.includes("run"));
    expect(mutating.some((a) => /-blue_|-green_/.test(a))).toBe(false);
  });
});
