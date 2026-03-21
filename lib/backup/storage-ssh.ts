// ---------------------------------------------------------------------------
// SSH/SCP Backup Storage Adapter
//
// Backs up to any SSH-accessible host (NAS over Tailscale, remote server,
// etc.) using scp for file transfer and ssh for remote operations.
// Implements the BackupStorage port interface.
// ---------------------------------------------------------------------------

import { exec } from "child_process";
import { promisify } from "util";
import { stat, writeFile as fsWriteFile, unlink } from "fs/promises";
import { nanoid } from "nanoid";
import type { BackupStorage } from "./storage-port";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SshConfig = {
  host: string;
  port?: number;
  username: string;
  /** PEM-encoded private key. If omitted, uses the system's default SSH key. */
  privateKey?: string;
  /** Remote directory path where backups are stored. */
  path: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build SSH/SCP flags common to all commands.
 * Writes the private key to a temp file if provided.
 * Returns the flags string and an optional cleanup function.
 */
async function buildSshFlags(
  config: SshConfig
): Promise<{ flags: string; keyFile?: string }> {
  const parts: string[] = [
    "-o StrictHostKeyChecking=accept-new",
    "-o ConnectTimeout=30",
  ];

  if (config.port && config.port !== 22) {
    parts.push(`-P ${config.port}`);
  }

  let keyFile: string | undefined;
  if (config.privateKey) {
    keyFile = `/tmp/.host-ssh-key-${nanoid(8)}`;
    await fsWriteFile(keyFile, config.privateKey, { mode: 0o600 });
    parts.push(`-i ${keyFile}`);
  }

  return { flags: parts.join(" "), keyFile };
}

/**
 * Build the ssh command flags (ssh uses -p, scp uses -P for port).
 */
async function buildSshCmdFlags(
  config: SshConfig
): Promise<{ flags: string; keyFile?: string }> {
  const { flags, keyFile } = await buildSshFlags(config);
  // Replace -P with -p for ssh command
  return { flags: flags.replace(/-P (\d+)/, "-p $1"), keyFile };
}

async function cleanupKeyFile(keyFile?: string): Promise<void> {
  if (keyFile) {
    try {
      await unlink(keyFile);
    } catch {
      // best effort
    }
  }
}

/** Join remote path segments, normalizing slashes. */
function remotePath(config: SshConfig, key: string): string {
  const base = config.path.replace(/\/+$/, "");
  return `${base}/${key}`;
}

/** Ensure remote directory exists. */
async function ensureRemoteDir(
  config: SshConfig,
  remoteDir: string
): Promise<void> {
  const { flags, keyFile } = await buildSshCmdFlags(config);
  try {
    await execAsync(
      `ssh ${flags} ${config.username}@${config.host} "mkdir -p '${remoteDir}'"`,
      { timeout: 30_000 }
    );
  } finally {
    await cleanupKeyFile(keyFile);
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SshBackupStorage implements BackupStorage {
  private config: SshConfig;

  constructor(config: SshConfig) {
    this.config = config;
  }

  async upload(key: string, filePath: string): Promise<{ sizeBytes: number }> {
    const remote = remotePath(this.config, key);
    const remoteDir = remote.substring(0, remote.lastIndexOf("/"));

    // Ensure remote directory structure exists
    await ensureRemoteDir(this.config, remoteDir);

    const { flags, keyFile } = await buildSshFlags(this.config);
    try {
      await execAsync(
        `scp ${flags} "${filePath}" "${this.config.username}@${this.config.host}:${remote}"`,
        { timeout: 600_000 } // 10 minute timeout
      );

      const fileInfo = await stat(filePath);
      return { sizeBytes: fileInfo.size };
    } finally {
      await cleanupKeyFile(keyFile);
    }
  }

  async download(key: string, destPath: string): Promise<void> {
    const remote = remotePath(this.config, key);
    const { flags, keyFile } = await buildSshFlags(this.config);

    try {
      await execAsync(
        `scp ${flags} "${this.config.username}@${this.config.host}:${remote}" "${destPath}"`,
        { timeout: 600_000 }
      );
    } finally {
      await cleanupKeyFile(keyFile);
    }
  }

  async delete(key: string): Promise<void> {
    const remote = remotePath(this.config, key);
    const { flags, keyFile } = await buildSshCmdFlags(this.config);

    try {
      await execAsync(
        `ssh ${flags} ${this.config.username}@${this.config.host} "rm -f '${remote}'"`,
        { timeout: 30_000 }
      );
    } finally {
      await cleanupKeyFile(keyFile);
    }
  }

  // SSH targets don't support pre-signed URLs.
  // getDownloadUrl is intentionally omitted from this adapter.
}
