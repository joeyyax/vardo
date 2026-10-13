import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import { identityToRecipient } from "age-encryption";
import {
  createArchiveEncryptor,
  decryptArchiveFile,
  deriveArchiveRecipient,
  readArchiveKind,
} from "@/lib/backups/archive-age";
import { deriveArchiveIdentity } from "@/lib/backups/archive-identity";

const KEY = "d".repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vardo-age-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seal(plain: Buffer, masterKey = KEY): Promise<string> {
  const src = join(dir, "plain");
  const out = join(dir, "sealed.age");
  await writeFile(src, plain);
  await pipeline(createReadStream(src), createArchiveEncryptor(await deriveArchiveRecipient(masterKey)), createWriteStream(out));
  return out;
}

describe("archive identity", () => {
  // Changing the derivation orphans every archive already written, so the output is pinned.
  it("derives the same age key pair for a master key as `age-keygen -y` reports for it", async () => {
    const identity = deriveArchiveIdentity(KEY);

    expect(identity).toMatch(/^AGE-SECRET-KEY-1[A-Z0-9]{58}$/);
    expect(await identityToRecipient(identity)).toBe("age1cg0y3m5xtv65j2ng89ud0xpt9y3klm7jjmcpdf020aq27pt4f54qvcl2zp");
  });

  it("gives different master keys different identities", () => {
    expect(deriveArchiveIdentity("e".repeat(64))).not.toBe(deriveArchiveIdentity(KEY));
  });
});

describe("archive encryption", () => {
  it("round-trips an archive spanning many age chunks", async () => {
    const plain = randomBytes(300_000);
    const sealed = await seal(plain);

    await decryptArchiveFile(sealed, join(dir, "back"), KEY);

    expect((await readFile(join(dir, "back"))).equals(plain)).toBe(true);
    expect(await readArchiveKind(sealed)).toBe("age");
  });

  it("refuses the wrong master key", async () => {
    const sealed = await seal(randomBytes(1000));

    await expect(decryptArchiveFile(sealed, join(dir, "back"), "e".repeat(64))).rejects.toMatchObject({
      name: "ArchiveDecryptError",
      wrongKey: true,
    });
  });

  it("refuses an archive with a flipped byte", async () => {
    const sealed = await seal(randomBytes(5000));
    const bytes = await readFile(sealed);
    bytes[bytes.length - 20] ^= 1;
    await writeFile(sealed, bytes);

    await expect(decryptArchiveFile(sealed, join(dir, "back"), KEY)).rejects.toMatchObject({
      name: "ArchiveDecryptError",
      wrongKey: false,
    });
  });

  it("refuses a truncated archive", async () => {
    const sealed = await seal(randomBytes(200_000));
    const bytes = await readFile(sealed);
    await writeFile(sealed, bytes.subarray(0, bytes.length - 70_000));

    await expect(decryptArchiveFile(sealed, join(dir, "back"), KEY)).rejects.toMatchObject({
      name: "ArchiveDecryptError",
      wrongKey: false,
    });
  });
});

describe("readArchiveKind", () => {
  it("calls an unrecognized file plaintext", async () => {
    await writeFile(join(dir, "gz"), Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]));

    expect(await readArchiveKind(join(dir, "gz"))).toBe("plain");
  });

  it("rejects the retired in-house format", async () => {
    await writeFile(join(dir, "old"), Buffer.concat([Buffer.from("VARDOENC"), Buffer.alloc(40)]));

    await expect(readArchiveKind(join(dir, "old"))).rejects.toThrow(/retired encryption format/);
  });
});
