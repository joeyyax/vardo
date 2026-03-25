// ---------------------------------------------------------------------------
// Backup Storage Port
//
// Defines the contract that all backup storage adapters must implement.
// The engine depends only on this interface, never on concrete transports.
// ---------------------------------------------------------------------------

export interface BackupStorage {
  /** Upload a local file to the storage target. Returns the size in bytes. */
  upload(key: string, filePath: string): Promise<{ sizeBytes: number }>;

  /** Download a file from the storage target to a local path. */
  download(key: string, destPath: string): Promise<void>;

  /** Delete a file from the storage target. */
  delete(key: string): Promise<void>;

  /**
   * Generate a pre-signed download URL (if the storage backend supports it).
   * Returns undefined/null for backends that don't support direct URLs
   * (e.g. SSH), in which case the caller should stream through the server.
   */
  getDownloadUrl?(key: string, expiresIn?: number): Promise<string>;
}
