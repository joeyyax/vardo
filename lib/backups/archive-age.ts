// Archive encryption in the age format (https://age-encryption.org), so any age client opens an archive:
//
//   vardo backup key > key.txt
//   age -d -i key.txt archive.tar.gz.age | tar -xz
//
// The identity is derived from ENCRYPTION_MASTER_KEY, so the key an operator already escrows is the only secret.
// The identity opens archives only; it can't recover the master key, which also protects env vars.

import { createReadStream, createWriteStream } from "fs";
import { open } from "fs/promises";
import { Duplex, Readable } from "stream";
import { pipeline } from "stream/promises";
import { Decrypter, Encrypter, identityToRecipient } from "age-encryption";
import { deriveArchiveIdentity } from "./archive-identity";

/** First line of every binary age file. */
const AGE_MAGIC = Buffer.from("age-encryption.org/v1\n", "ascii");
/** First bytes of an archive in the retired in-house format. */
const LEGACY_MAGIC = Buffer.from("VARDOENC", "ascii");

/** age's error when no identity opens the file. */
const NO_MATCH = "no identity matched";

export class ArchiveDecryptError extends Error {
  /** True when the key doesn't open the archive; false when the archive is damaged or unreadable. */
  readonly wrongKey: boolean;

  constructor(message: string, wrongKey = false) {
    super(message);
    this.name = "ArchiveDecryptError";
    this.wrongKey = wrongKey;
  }
}

/** The public age recipient (`age1...`) for the master key's identity. Keep it private: anyone holding it can write archives that restore. */
export function deriveArchiveRecipient(masterKey: string): Promise<string> {
  return identityToRecipient(deriveArchiveIdentity(masterKey));
}

const toWeb = (source: AsyncIterable<Uint8Array>) =>
  Readable.toWeb(Readable.from(source, { objectMode: false })) as ReadableStream<Uint8Array>;

/** A stream that encrypts what is written to it to `recipient`. */
export function createArchiveEncryptor(recipient: string): Duplex {
  return Duplex.from(async function* (source: AsyncIterable<Uint8Array>) {
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    yield* Readable.fromWeb((await encrypter.encrypt(toWeb(source))) as never);
  });
}

/** A stream that decrypts an age archive. Fails if the identity doesn't match or any byte was altered. */
export function createArchiveDecryptor(identity: string): Duplex {
  return Duplex.from(async function* (source: AsyncIterable<Uint8Array>) {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    try {
      yield* Readable.fromWeb((await decrypter.decrypt(toWeb(source))) as never);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(NO_MATCH)) throw new ArchiveDecryptError("This key doesn't open the archive.", true);
      throw new ArchiveDecryptError(`The archive is damaged and can't be decrypted: ${message}`);
    }
  });
}

/** Whether a file is an age archive or plaintext. Throws for the retired format, which nothing can read. */
export async function readArchiveKind(path: string): Promise<"age" | "plain"> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(AGE_MAGIC.length);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (bytes.equals(AGE_MAGIC)) return "age";
    if (bytes.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
      throw new ArchiveDecryptError("This archive uses a retired encryption format and can't be restored. Delete it.");
    }
    return "plain";
  } finally {
    await file.close();
  }
}

export async function decryptArchiveFile(inPath: string, outPath: string, masterKey: string | undefined): Promise<void> {
  if (!masterKey) throw new ArchiveDecryptError("ENCRYPTION_MASTER_KEY is not set");
  await pipeline(createReadStream(inPath), createArchiveDecryptor(deriveArchiveIdentity(masterKey)), createWriteStream(outPath));
}
