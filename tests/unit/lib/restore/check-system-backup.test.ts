import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { gzipSync } from "zlib";
import { join } from "path";
import { tmpdir } from "os";
import { createArchiveEncryptor, deriveArchiveRecipient } from "@/lib/backups/archive-age";
import { checkSystemBackup } from "@/lib/restore/source";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("@/lib/restore/auth-secret", () => ({ checkDumpAuthSecret: vi.fn(async () => ({ kind: "none" })) }));

const KEY = "a".repeat(64);
const BACKUP = "vardo-system/postgres/2026-10-13T00-00-00-000Z.dump.gz.age";

let dir: string;
let target: { type: "local"; config: { path: string } };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vardo-check-test-"));
  target = { type: "local", config: { path: dir } };
  vi.stubEnv("ENCRYPTION_MASTER_KEY", KEY);
  await mkdir(join(dir, "vardo-system/postgres"), { recursive: true });
  const plain = join(dir, "plain.gz");
  await writeFile(plain, gzipSync("-- dump\n"));
  await pipeline(
    createReadStream(plain),
    createArchiveEncryptor(await deriveArchiveRecipient(KEY)),
    createWriteStream(join(dir, BACKUP)),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("checkSystemBackup", () => {
  it("opens the archive with the right key", async () => {
    const result = await checkSystemBackup(target, BACKUP, KEY);

    expect(result.key.kind).toBe("match");
  });

  it("reports the wrong key", async () => {
    const result = await checkSystemBackup(target, BACKUP, "b".repeat(64));

    expect(result.key.kind).toBe("wrong-key");
  });

  it("reports a damaged archive as damaged, not as the wrong key", async () => {
    const bytes = await readFile(join(dir, BACKUP));
    bytes[bytes.length - 5] ^= 1;
    await writeFile(join(dir, BACKUP), bytes);

    await expect(checkSystemBackup(target, BACKUP, KEY)).rejects.toMatchObject({
      name: "ArchiveDecryptError",
      wrongKey: false,
    });
  });
});
