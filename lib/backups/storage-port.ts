// Contract every backup storage adapter implements.

export interface BackupStorage {
  /** Upload a local file to the storage target. Returns the size in bytes. */
  upload(key: string, filePath: string): Promise<{ sizeBytes: number }>;

  /** Download a file from the storage target to a local path. */
  download(key: string, destPath: string): Promise<void>;

  /** Delete a file from the storage target. */
  delete(key: string): Promise<void>;

  /** Pre-signed download URL, where the backend supports one. */
  getDownloadUrl?(key: string, expiresIn?: number): Promise<string>;
}

/** The archive a backup row points at is gone from its target. */
export class ArchiveMissingError extends Error {
  constructor() {
    super("This backup's archive is missing from storage");
    this.name = "ArchiveMissingError";
  }
}
