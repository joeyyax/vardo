// ---------------------------------------------------------------------------
// Local Filesystem Backup Storage Adapter
//
// Stores backups on the server's local filesystem. Useful for development,
// single-node setups, or as a staging area before replication.
// Implements the BackupStorage port interface.
// ---------------------------------------------------------------------------

import { copyFile, mkdir, unlink, stat } from "fs/promises";
import { resolve, dirname } from "path";
import type { BackupStorage } from "./storage-port";

export type LocalStorageConfig = {
  path: string; // e.g. "/opt/vardo/backups"
};

export class LocalBackupStorage implements BackupStorage {
  private basePath: string;

  constructor(config: LocalStorageConfig) {
    this.basePath = resolve(config.path);
  }

  /** Guard against path traversal — resolved dest must stay under basePath. */
  private safePath(key: string): string {
    const dest = resolve(this.basePath, key);
    if (!dest.startsWith(this.basePath + "/")) {
      throw new Error("Invalid backup key: path traversal detected");
    }
    return dest;
  }

  async upload(key: string, filePath: string): Promise<{ sizeBytes: number }> {
    const dest = this.safePath(key);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(filePath, dest);
    const info = await stat(dest);
    return { sizeBytes: info.size };
  }

  async download(key: string, destPath: string): Promise<void> {
    const src = this.safePath(key);
    await copyFile(src, destPath);
  }

  async delete(key: string): Promise<void> {
    const target = this.safePath(key);
    await unlink(target);
  }

  // No getDownloadUrl — same as SSH. Downloads stream through the server.
}
