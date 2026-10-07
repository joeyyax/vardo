import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { Readable, type Transform } from "stream";
import { pipeline } from "stream/promises";
import {
  ARCHIVE_MAGIC,
  ArchiveDecryptError,
  createArchiveDecryptor,
  createArchiveEncryptor,
  decryptArchiveFile,
  encryptArchiveFile,
  isEncryptedArchiveFile,
  unwrapDataKey,
} from "@/lib/backups/archive-crypto";
import { fingerprintMasterKey } from "@/lib/crypto/key-fingerprint";
import { main as decryptCli } from "@/scripts/backup-decrypt";

const KEY = "a".repeat(64);
const OTHER_KEY = "c".repeat(64);
const TAG = 16;

const dir = mkdtempSync(join(tmpdir(), "vardo-archive-crypto-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Feed `input` in small irregular pieces, as a real file stream would. */
async function run(stream: Transform, input: Buffer): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (let i = 0; i < input.length; ) {
    const n = 1 + ((i * 7919) % 50);
    pieces.push(input.subarray(i, i + n));
    i += n;
  }
  const out: Buffer[] = [];
  await pipeline(Readable.from(pieces), stream, async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) out.push(chunk);
  });
  return Buffer.concat(out);
}

async function encrypt(plain: Buffer, chunkSize = 64) {
  const { stream, key } = createArchiveEncryptor(KEY, { chunkSize });
  return { sealed: await run(stream, plain), key };
}

const decrypt = (sealed: Buffer, key = KEY, opts = {}) => run(createArchiveDecryptor(key, opts), sealed);

function headerLength(sealed: Buffer): number {
  let at = 22;
  at += 1 + sealed[at];
  at += 1 + sealed[at];
  return at;
}

describe("archive stream format", () => {
  it("round-trips a single chunk", async () => {
    const plain = Buffer.from("hello archive");
    const { sealed } = await encrypt(plain);
    expect(sealed.subarray(0, 8).equals(ARCHIVE_MAGIC)).toBe(true);
    expect(sealed.includes(plain)).toBe(false);
    expect((await decrypt(sealed)).equals(plain)).toBe(true);
  });

  it("round-trips many chunks, including an exact multiple of the chunk size", async () => {
    for (const size of [64 * 5, 64 * 5 + 1, 64 * 5 - 1, 1000]) {
      const plain = randomBytes(size);
      const { sealed } = await encrypt(plain);
      const chunks = Math.max(1, Math.ceil(size / 64));
      expect(sealed.length).toBe(headerLength(sealed) + size + chunks * TAG);
      expect((await decrypt(sealed)).equals(plain)).toBe(true);
    }
  });

  it("round-trips empty input as a single empty final chunk", async () => {
    const { sealed } = await encrypt(Buffer.alloc(0));
    expect(sealed.length).toBe(headerLength(sealed) + TAG);
    expect((await decrypt(sealed)).length).toBe(0);
  });

  it("records the wrapped key and master-key fingerprint, and the header carries the same key", async () => {
    const { sealed, key } = await encrypt(Buffer.from("x"));
    expect(key.keyFingerprint).toBe(fingerprintMasterKey(KEY));
    expect(sealed.includes(Buffer.from(key.wrappedKey, "base64"))).toBe(true);
    expect(unwrapDataKey(key, KEY)).toHaveLength(32);
  });

  it("uses a fresh data key per archive", async () => {
    const plain = Buffer.alloc(100, 1);
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a.key.wrappedKey).not.toBe(b.key.wrappedKey);
    expect(a.sealed.subarray(headerLength(a.sealed)).equals(b.sealed.subarray(headerLength(b.sealed)))).toBe(false);
  });

  it("fails when the archive is truncated at a chunk boundary", async () => {
    const { sealed } = await encrypt(randomBytes(64 * 3 + 10));
    const cut = sealed.subarray(0, headerLength(sealed) + 2 * (64 + TAG));
    await expect(decrypt(cut)).rejects.toThrow(/chunk 1 failed authentication/);
  });

  it("fails when the archive is truncated mid-chunk or inside the header", async () => {
    const { sealed } = await encrypt(randomBytes(200));
    await expect(decrypt(sealed.subarray(0, sealed.length - 5))).rejects.toThrow(ArchiveDecryptError);
    await expect(decrypt(sealed.subarray(0, 20))).rejects.toThrow(/header is truncated/);
  });

  it("fails when data is appended after the final chunk", async () => {
    const { sealed } = await encrypt(randomBytes(64 * 2));
    await expect(decrypt(Buffer.concat([sealed, randomBytes(64 + TAG)]))).rejects.toThrow(ArchiveDecryptError);
  });

  it("fails on a flipped ciphertext bit", async () => {
    const { sealed } = await encrypt(randomBytes(300));
    const tampered = Buffer.from(sealed);
    tampered[headerLength(sealed) + 70] ^= 1;
    await expect(decrypt(tampered)).rejects.toThrow(/chunk 0 failed authentication/);
  });

  it("fails on a tampered header field", async () => {
    const { sealed } = await encrypt(randomBytes(300));
    const tampered = Buffer.from(sealed);
    tampered[15] ^= 1; // nonce prefix
    await expect(decrypt(tampered)).rejects.toThrow(ArchiveDecryptError);
  });

  it("fails when chunks are reordered", async () => {
    const { sealed } = await encrypt(randomBytes(64 * 3));
    const h = headerLength(sealed);
    const c = 64 + TAG;
    const swapped = Buffer.concat([
      sealed.subarray(0, h),
      sealed.subarray(h + c, h + 2 * c),
      sealed.subarray(h, h + c),
      sealed.subarray(h + 2 * c),
    ]);
    await expect(decrypt(swapped)).rejects.toThrow(/chunk 0 failed authentication/);
  });

  it("refuses the wrong master key", async () => {
    const { sealed } = await encrypt(Buffer.from("secret"));
    await expect(decrypt(sealed, OTHER_KEY)).rejects.toThrow(/wrapped by master key k1:/);
    await expect(decrypt(sealed, "")).rejects.toThrow(/ENCRYPTION_MASTER_KEY is not set/);
  });

  it("refuses a forged key id that names the running key", async () => {
    const { key } = await encrypt(Buffer.from("x"));
    expect(() => unwrapDataKey({ ...key, keyFingerprint: fingerprintMasterKey(OTHER_KEY) }, OTHER_KEY)).toThrow(
      /could not be unwrapped/,
    );
  });

  it("passes a legacy plaintext archive through unchanged", async () => {
    const legacy = randomBytes(500);
    legacy[0] = 0x1f;
    legacy[1] = 0x8b;
    expect((await decrypt(legacy)).equals(legacy)).toBe(true);
    expect((await decrypt(Buffer.alloc(0))).length).toBe(0);
  });

  it("rejects plaintext when the backup was recorded as encrypted", async () => {
    await expect(decrypt(Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5, 6, 7]), KEY, { requireEncrypted: true })).rejects.toThrow(
      /not encrypted/,
    );
  });
});

describe("archive file helpers", () => {
  it("encrypts and decrypts a file across the default chunk size", async () => {
    const plain = randomBytes(1024 * 1024 * 2 + 123);
    const src = join(dir, "src.tar.gz");
    const enc = join(dir, "src.tar.gz.enc");
    const out = join(dir, "out.tar.gz");
    writeFileSync(src, plain);

    const key = await encryptArchiveFile(src, enc, KEY);
    expect(key.keyFingerprint).toBe(fingerprintMasterKey(KEY));
    expect(await isEncryptedArchiveFile(enc)).toBe(true);
    expect(await isEncryptedArchiveFile(src)).toBe(false);

    expect(await decryptArchiveFile(enc, out, KEY)).toEqual({ encrypted: true });
    expect(readFileSync(out).equals(plain)).toBe(true);
  });
});

describe("backup decrypt CLI", () => {
  it("decrypts with only the file and the master key", async () => {
    const plain = randomBytes(5000);
    const src = join(dir, "cli-src");
    const enc = join(dir, "cli.enc");
    const out = join(dir, "cli.out");
    writeFileSync(src, plain);
    await encryptArchiveFile(src, enc, KEY);

    expect(await decryptCli([enc, out], { ENCRYPTION_MASTER_KEY: KEY })).toBe(0);
    expect(readFileSync(out).equals(plain)).toBe(true);
  });

  it("fails and leaves no output on the wrong key", async () => {
    const src = join(dir, "cli-src2");
    const enc = join(dir, "cli2.enc");
    const out = join(dir, "cli2.out");
    writeFileSync(src, randomBytes(100));
    await encryptArchiveFile(src, enc, KEY);

    expect(await decryptCli([enc, out], { ENCRYPTION_MASTER_KEY: OTHER_KEY })).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it("requires the master key and two paths", async () => {
    expect(await decryptCli(["a", "b"], {})).toBe(2);
    expect(await decryptCli(["a"], { ENCRYPTION_MASTER_KEY: KEY })).toBe(2);
  });
});
