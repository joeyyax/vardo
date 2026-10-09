// Local filesystem backup storage adapter.

import { createWriteStream } from "fs";
import { copyFile, mkdir, readdir, rename, unlink, stat } from "fs/promises";
import { resolve, dirname, join, relative, sep } from "path";
import type { Readable } from "stream";
import { pipeline } from "stream/promises";
import { nanoid } from "nanoid";
import { ArchiveMissingError, type BackupStorage, type StoredObject } from "./storage-port";

export type LocalStorageConfig = {
  path: string; // e.g. "/opt/vardo/backups"
};

export class LocalBackupStorage implements BackupStorage {
  private basePath: string;

  constructor(config: LocalStorageConfig) {
    this.basePath = resolve(config.path);
  }

  /** Path traversal guard: resolved dest must stay under basePath. */
  private safePath(key: string): string {
    const dest = resolve(this.basePath, key);
    if (!dest.startsWith(this.basePath + "/")) {
      throw new Error("Invalid backup key: path traversal detected");
    }
    return dest;
  }

  async uploadStream(key: string, body: Readable): Promise<{ sizeBytes: number }> {
    const dest = this.safePath(key);
    await mkdir(dirname(dest), { recursive: true });
    const partial = `${dest}.partial-${nanoid(6)}`;
    try {
      await pipeline(body, createWriteStream(partial));
      await rename(partial, dest);
    } catch (err) {
      await unlink(partial).catch(() => {});
      throw err;
    }
    return { sizeBytes: (await stat(dest)).size };
  }

  async download(key: string, destPath: string): Promise<void> {
    const src = this.safePath(key);
    try {
      await copyFile(src, destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ArchiveMissingError();
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.safePath(key);
    try {
      await unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ArchiveMissingError();
      throw err;
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const dir = resolve(this.basePath, dirname(`${prefix}x`));
    if (dir !== this.basePath && !dir.startsWith(this.basePath + "/")) {
      throw new Error("Invalid backup prefix: path traversal detected");
    }
    let entries;
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const found: StoredObject[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      const key = relative(this.basePath, path).split(sep).join("/");
      if (!key.startsWith(prefix)) continue;
      const info = await stat(path);
      found.push({ key, sizeBytes: info.size, modifiedAt: info.mtime });
    }
    return found;
  }

  // No getDownloadUrl: downloads stream through the server.
}
