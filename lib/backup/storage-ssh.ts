// ---------------------------------------------------------------------------
// SSH/SCP Backup Storage Adapter
//
// Backs up to any SSH-accessible host (NAS over Tailscale, remote server,
// etc.) using scp for file transfer and ssh for remote operations.
// Implements the BackupStorage port interface.
// ---------------------------------------------------------------------------

import { execFile } from "child_process";
import { promisify } from "util";
import { stat, writeFile as fsWriteFile, unlink } from "fs/promises";
import { nanoid } from "nanoid";
import type { BackupStorage } from "./storage-port";

const execFileAsync = promisify(execFile);

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
 * Escape a string for safe inclusion in a remote shell command.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Build SSH/SCP flag arrays common to all commands.
 * Writes the private key to a temp file if provided.
 * Returns separate arrays for scp flags and ssh flags (they differ in port flag).
 */
async function buildFlags(
  config: SshConfig
): Promise<{ scpFlags: string[]; sshFlags: string[]; keyFile?: string }> {
  const common: string[] = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=30",
  ];

  let keyFile: string | undefined;
  if (config.privateKey) {
    keyFile = `/tmp/.host-ssh-key-${nanoid(8)}`;
    await fsWriteFile(keyFile, config.privateKey, { mode: 0o600 });
    common.push("-i", keyFile);
  }

  const scpFlags = [...common];
  const sshFlags = [...common];

  if (config.port && config.port !== 22) {
    scpFlags.push("-P", String(config.port));
    sshFlags.push("-p", String(config.port));
  }

  return { scpFlags, sshFlags, keyFile };
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
  const { sshFlags, keyFile } = await buildFlags(config);
  try {
    await execFileAsync(
      "ssh",
      [
        ...sshFlags,
        "--",
        `${config.username}@${config.host}`,
        "mkdir", "-p", remoteDir,
      ],
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

    const { scpFlags, keyFile } = await buildFlags(this.config);
    try {
      await execFileAsync(
        "scp",
        [
          ...scpFlags,
          "--",
          filePath,
          `${this.config.username}@${this.config.host}:${remote}`,
        ],
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
    const { scpFlags, keyFile } = await buildFlags(this.config);

    try {
      await execFileAsync(
        "scp",
        [
          ...scpFlags,
          "--",
          `${this.config.username}@${this.config.host}:${remote}`,
          destPath,
        ],
        { timeout: 600_000 }
      );
    } finally {
      await cleanupKeyFile(keyFile);
    }
  }

  async delete(key: string): Promise<void> {
    const remote = remotePath(this.config, key);
    const { sshFlags, keyFile } = await buildFlags(this.config);

    try {
      await execFileAsync(
        "ssh",
        [
          ...sshFlags,
          "--",
          `${this.config.username}@${this.config.host}`,
          "rm", "-f", remote,
        ],
        { timeout: 30_000 }
      );
    } finally {
      await cleanupKeyFile(keyFile);
    }
  }

  // SSH targets don't support pre-signed URLs.
  // getDownloadUrl is intentionally omitted from this adapter.
}
