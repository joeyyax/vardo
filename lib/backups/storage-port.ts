// Contract every backup storage adapter implements.

import type { Readable } from "stream";

/** One object found by a listing. */
export type StoredObject = { key: string; sizeBytes: number; modifiedAt: Date };

export interface BackupStorage {
  /**
   * Write a stream to the target. Nothing is visible under `key` unless the stream ends cleanly.
   * Not retried as a whole: the stream can't be replayed. Adapters retry what they buffer.
   */
  uploadStream(key: string, body: Readable): Promise<{ sizeBytes: number }>;

  /** Download a file from the storage target to a local path. */
  download(key: string, destPath: string): Promise<void>;

  /** Delete a file from the storage target. */
  delete(key: string): Promise<void>;

  /** Pre-signed download URL, where the backend supports one. */
  getDownloadUrl?(key: string, expiresIn?: number): Promise<string>;

  /** Objects whose key starts with `prefix`. */
  list(prefix: string): Promise<StoredObject[]>;
}

/** The archive a backup row points at is gone from its target. */
export class ArchiveMissingError extends Error {
  constructor() {
    super("This backup's archive is missing from storage");
    this.name = "ArchiveMissingError";
  }
}
