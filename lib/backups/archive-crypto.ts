// ---------------------------------------------------------------------------
// Archive encryption
//
// Format v1, all integers big-endian:
//
//   header  magic "VARDOENC" (8) | version (1) | wrap scheme (1)
//           | chunk size u32 (4) | nonce prefix (8)
//           | key id length (1) | key id (ascii)
//           | wrapped key length (1) | wrapped key
//   chunks  AES-256-GCM ciphertext (≤ chunk size) | tag (16), repeated
//
// - Data key: 32 random bytes per archive.
// - Wrap scheme 1: the data key sealed with AES-256-GCM under a key derived from
//   ENCRYPTION_MASTER_KEY. Wrapped key = iv (12) | ciphertext (32) | tag (16),
//   AAD = key id. Key id is the master-key fingerprint.
// - Chunk n: nonce = prefix | n as u32, AAD = header | n as u32 | final flag (1).
//   Every chunk but the last is exactly chunk size. The last carries final = 1
//   and may be empty, so truncation, reordering and appended data all fail.
//
// Anything without the magic is a legacy plaintext archive.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { open } from "fs/promises";
import { Transform, type TransformCallback } from "stream";
import { pipeline } from "stream/promises";
import { fingerprintMasterKey, normalizeMasterKey } from "../crypto/key-fingerprint";

export const ARCHIVE_MAGIC = Buffer.from("VARDOENC", "ascii");
export const ARCHIVE_FORMAT_VERSION = 1;
/** The data key is wrapped by the instance master key. */
export const WRAP_SCHEME_MASTER = 1;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
/** Bounds what a decryptor will buffer for one chunk. */
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const NONCE_PREFIX_LENGTH = 8;
const FIXED_HEADER_LENGTH = ARCHIVE_MAGIC.length + 1 + 1 + 4 + NONCE_PREFIX_LENGTH;
const MAX_CHUNKS = 0xffffffff;

/** What a backup row records about its archive's key. */
export type ArchiveKey = {
  /** Base64 of the wrapped data key, identical to the copy in the header. */
  wrappedKey: string;
  /** Fingerprint of the key that wrapped it. */
  keyFingerprint: string;
};

export class ArchiveDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveDecryptError";
  }
}

function wrappingKey(masterKey: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", normalizeMasterKey(masterKey), "vardo-archive-key/v1", "key-wrap", KEY_LENGTH),
  );
}

export function wrapDataKey(dataKey: Buffer, masterKey: string): ArchiveKey {
  const keyFingerprint = fingerprintMasterKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey(masterKey), iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(keyFingerprint, "ascii"));
  const sealed = Buffer.concat([iv, cipher.update(dataKey), cipher.final(), cipher.getAuthTag()]);
  return { wrappedKey: sealed.toString("base64"), keyFingerprint };
}

export function unwrapDataKey(key: ArchiveKey, masterKey: string): Buffer {
  const running = fingerprintMasterKey(masterKey);
  if (running !== key.keyFingerprint) {
    throw new ArchiveDecryptError(
      `Archive key is wrapped by master key ${key.keyFingerprint}, but the running key is ${running}`,
    );
  }
  const sealed = Buffer.from(key.wrappedKey, "base64");
  if (sealed.length !== IV_LENGTH + KEY_LENGTH + TAG_LENGTH) {
    throw new ArchiveDecryptError("Archive key has the wrong length");
  }
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey(masterKey), sealed.subarray(0, IV_LENGTH), {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(key.keyFingerprint, "ascii"));
  decipher.setAuthTag(sealed.subarray(IV_LENGTH + KEY_LENGTH));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(IV_LENGTH, IV_LENGTH + KEY_LENGTH)), decipher.final()]);
  } catch {
    throw new ArchiveDecryptError("Archive key could not be unwrapped with the running master key");
  }
}

function encodeHeader(chunkSize: number, noncePrefix: Buffer, key: ArchiveKey): Buffer {
  const keyId = Buffer.from(key.keyFingerprint, "ascii");
  const wrapped = Buffer.from(key.wrappedKey, "base64");
  const fixed = Buffer.alloc(FIXED_HEADER_LENGTH);
  ARCHIVE_MAGIC.copy(fixed, 0);
  fixed.writeUInt8(ARCHIVE_FORMAT_VERSION, 8);
  fixed.writeUInt8(WRAP_SCHEME_MASTER, 9);
  fixed.writeUInt32BE(chunkSize, 10);
  noncePrefix.copy(fixed, 14);
  return Buffer.concat([fixed, Buffer.from([keyId.length]), keyId, Buffer.from([wrapped.length]), wrapped]);
}

type Header = { bytes: Buffer; chunkSize: number; noncePrefix: Buffer; key: ArchiveKey };

/** Parse a header from the front of `buf`. Null when more bytes are needed. */
function decodeHeader(buf: Buffer): Header | null {
  if (buf.length < FIXED_HEADER_LENGTH + 1) return null;
  const version = buf.readUInt8(8);
  if (version !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveDecryptError(`Unsupported archive format version ${version}`);
  }
  const scheme = buf.readUInt8(9);
  if (scheme !== WRAP_SCHEME_MASTER) {
    throw new ArchiveDecryptError(`Unsupported archive key scheme ${scheme}`);
  }
  const chunkSize = buf.readUInt32BE(10);
  if (chunkSize === 0 || chunkSize > MAX_CHUNK_SIZE) {
    throw new ArchiveDecryptError(`Archive chunk size ${chunkSize} is out of range`);
  }
  const noncePrefix = Buffer.from(buf.subarray(14, FIXED_HEADER_LENGTH));

  let at = FIXED_HEADER_LENGTH;
  const keyIdLength = buf.readUInt8(at++);
  if (buf.length < at + keyIdLength + 1) return null;
  const keyFingerprint = buf.subarray(at, at + keyIdLength).toString("ascii");
  at += keyIdLength;
  const wrappedLength = buf.readUInt8(at++);
  if (buf.length < at + wrappedLength) return null;
  const wrappedKey = buf.subarray(at, at + wrappedLength).toString("base64");
  at += wrappedLength;

  return {
    bytes: Buffer.from(buf.subarray(0, at)),
    chunkSize,
    noncePrefix,
    key: { wrappedKey, keyFingerprint },
  };
}

function chunkNonce(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(IV_LENGTH);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, NONCE_PREFIX_LENGTH);
  return nonce;
}

function chunkAad(header: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(index, 0);
  tail.writeUInt8(final ? 1 : 0, 4);
  return Buffer.concat([header, tail]);
}

/** Byte queue that copies only when a chunk is taken off the front. */
class ByteQueue {
  private parts: Buffer[] = [];
  length = 0;

  push(buf: Buffer) {
    if (buf.length === 0) return;
    this.parts.push(buf);
    this.length += buf.length;
  }

  peek(): Buffer {
    if (this.parts.length > 1) this.parts = [Buffer.concat(this.parts)];
    return this.parts[0] ?? Buffer.alloc(0);
  }

  take(n: number): Buffer {
    const all = this.peek();
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    this.parts = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return head;
  }
}

class ArchiveEncryptor extends Transform {
  private queue = new ByteQueue();
  private index = 0;
  private headerSent = false;

  constructor(
    private readonly dataKey: Buffer,
    private readonly header: Buffer,
    private readonly noncePrefix: Buffer,
    private readonly chunkSize: number,
  ) {
    super();
  }

  private seal(plain: Buffer, final: boolean): Buffer {
    if (this.index > MAX_CHUNKS) throw new Error("Archive exceeds the chunk limit");
    const cipher = createCipheriv("aes-256-gcm", this.dataKey, chunkNonce(this.noncePrefix, this.index), {
      authTagLength: TAG_LENGTH,
    });
    cipher.setAAD(chunkAad(this.header, this.index, final));
    this.index++;
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }

  private sendHeader() {
    if (this.headerSent) return;
    this.headerSent = true;
    this.push(this.header);
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      this.sendHeader();
      this.queue.push(chunk);
      // Keep at least one chunk back: only flush knows which chunk is final.
      while (this.queue.length > this.chunkSize) {
        this.push(this.seal(this.queue.take(this.chunkSize), false));
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  _flush(cb: TransformCallback) {
    try {
      this.sendHeader();
      this.push(this.seal(this.queue.take(this.queue.length), true));
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

/**
 * A stream that encrypts what is written to it. `key` is what the backup row
 * records; the same wrapped key is written into the header.
 */
export function createArchiveEncryptor(
  masterKey: string,
  opts: { chunkSize?: number } = {},
): { stream: Transform; key: ArchiveKey } {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) throw new Error(`Chunk size ${chunkSize} is out of range`);
  const dataKey = randomBytes(KEY_LENGTH);
  const noncePrefix = randomBytes(NONCE_PREFIX_LENGTH);
  const key = wrapDataKey(dataKey, masterKey);
  const header = encodeHeader(chunkSize, noncePrefix, key);
  return { stream: new ArchiveEncryptor(dataKey, header, noncePrefix, chunkSize), key };
}

export type DecryptOptions = {
  /** Fail on an archive without the magic header instead of passing it through. */
  requireEncrypted?: boolean;
};

/**
 * A stream that decrypts an archive, or passes a legacy plaintext one through
 * unchanged. Fails at the first chunk that does not authenticate.
 */
class ArchiveDecryptor extends Transform {
  private queue = new ByteQueue();
  private mode: "sniff" | "header" | "chunks" | "plain" = "sniff";
  private header: Header | null = null;
  private dataKey: Buffer | null = null;
  private index = 0;

  constructor(
    private readonly masterKey: string | undefined,
    private readonly opts: DecryptOptions,
  ) {
    super();
  }

  /** Whether the input carried the magic header. Set once the first bytes arrive. */
  encrypted: boolean | null = null;

  private open(sealed: Buffer, final: boolean): Buffer {
    const header = this.header!;
    if (this.index > MAX_CHUNKS) throw new ArchiveDecryptError("Archive exceeds the chunk limit");
    const decipher = createDecipheriv("aes-256-gcm", this.dataKey!, chunkNonce(header.noncePrefix, this.index), {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(chunkAad(header.bytes, this.index, final));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
    try {
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LENGTH)), decipher.final()]);
      this.index++;
      return plain;
    } catch {
      throw new ArchiveDecryptError(
        `Archive chunk ${this.index} failed authentication — the archive is corrupt, truncated or tampered with`,
      );
    }
  }

  private advance(ending: boolean) {
    if (this.mode === "sniff") {
      if (this.queue.length < ARCHIVE_MAGIC.length && !ending) return;
      const head = this.queue.peek().subarray(0, ARCHIVE_MAGIC.length);
      this.encrypted = head.equals(ARCHIVE_MAGIC);
      if (!this.encrypted) {
        if (this.opts.requireEncrypted) {
          throw new ArchiveDecryptError("Archive is not encrypted, but this backup was recorded as encrypted");
        }
        this.mode = "plain";
      } else {
        this.mode = "header";
      }
    }

    if (this.mode === "plain") {
      if (this.queue.length > 0) this.push(this.queue.take(this.queue.length));
      return;
    }

    if (this.mode === "header") {
      const header = decodeHeader(this.queue.peek());
      if (!header) {
        if (ending) throw new ArchiveDecryptError("Archive header is truncated");
        return;
      }
      if (!this.masterKey) throw new ArchiveDecryptError("ENCRYPTION_MASTER_KEY is not set — cannot decrypt archive");
      this.header = header;
      this.dataKey = unwrapDataKey(header.key, this.masterKey);
      this.queue.take(header.bytes.length);
      this.mode = "chunks";
    }

    const sealedSize = this.header!.chunkSize + TAG_LENGTH;
    while (this.queue.length > sealedSize) {
      this.push(this.open(this.queue.take(sealedSize), false));
    }
    if (ending) {
      if (this.queue.length < TAG_LENGTH) {
        throw new ArchiveDecryptError("Archive is truncated — the final chunk is missing");
      }
      this.push(this.open(this.queue.take(this.queue.length), true));
    }
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      this.queue.push(chunk);
      this.advance(false);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  _flush(cb: TransformCallback) {
    try {
      this.advance(true);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

export function createArchiveDecryptor(
  masterKey: string | undefined,
  opts: DecryptOptions = {},
): Transform & { encrypted: boolean | null } {
  return new ArchiveDecryptor(masterKey, opts);
}

/** Whether a file starts with the archive magic. */
export async function isEncryptedArchiveFile(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(ARCHIVE_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(ARCHIVE_MAGIC);
  } finally {
    await handle.close();
  }
}

export async function encryptArchiveFile(
  inPath: string,
  outPath: string,
  masterKey: string,
  opts: { chunkSize?: number } = {},
): Promise<ArchiveKey> {
  const { stream, key } = createArchiveEncryptor(masterKey, opts);
  await pipeline(createReadStream(inPath), stream, createWriteStream(outPath));
  return key;
}

/** Decrypt a file, or copy it through if it is a legacy plaintext archive. Returns which. */
export async function decryptArchiveFile(
  inPath: string,
  outPath: string,
  masterKey: string | undefined,
  opts: DecryptOptions = {},
): Promise<{ encrypted: boolean }> {
  const decryptor = createArchiveDecryptor(masterKey, opts);
  await pipeline(createReadStream(inPath), decryptor, createWriteStream(outPath));
  return { encrypted: decryptor.encrypted === true };
}
