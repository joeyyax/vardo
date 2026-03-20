// ---------------------------------------------------------------------------
// SSH/SCP backup storage transport
//
// Backs up to any SSH-accessible host (NAS over Tailscale, remote server,
// etc.) using scp for file transfer and ssh for remote operations.
// ---------------------------------------------------------------------------

import { exec } from "child_process";
import { promisify } from "util";
import { stat, writeFile as fsWriteFile, unlink } from "fs/promises";
import { join } from "path";
import { nanoid } from "nanoid";

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
// Operations
// ---------------------------------------------------------------------------

/**
 * Upload a local file to the SSH target via scp.
 */
export async function uploadViaSsh(
  config: SshConfig,
  key: string,
  filePath: string
): Promise<{ sizeBytes: number }> {
  const remote = remotePath(config, key);
  const remoteDir = remote.substring(0, remote.lastIndexOf("/"));

  // Ensure remote directory structure exists
  await ensureRemoteDir(config, remoteDir);

  const { flags, keyFile } = await buildSshFlags(config);
  try {
    await execAsync(
      `scp ${flags} "${filePath}" "${config.username}@${config.host}:${remote}"`,
      { timeout: 600_000 } // 10 minute timeout
    );

    const fileInfo = await stat(filePath);
    return { sizeBytes: fileInfo.size };
  } finally {
    await cleanupKeyFile(keyFile);
  }
}

/**
 * Download a file from the SSH target via scp.
 */
export async function downloadViaSsh(
  config: SshConfig,
  key: string,
  destPath: string
): Promise<void> {
  const remote = remotePath(config, key);
  const { flags, keyFile } = await buildSshFlags(config);

  try {
    await execAsync(
      `scp ${flags} "${config.username}@${config.host}:${remote}" "${destPath}"`,
      { timeout: 600_000 }
    );
  } finally {
    await cleanupKeyFile(keyFile);
  }
}

/**
 * Delete a file on the SSH target.
 */
export async function deleteViaSsh(
  config: SshConfig,
  key: string
): Promise<void> {
  const remote = remotePath(config, key);
  const { flags, keyFile } = await buildSshCmdFlags(config);

  try {
    await execAsync(
      `ssh ${flags} ${config.username}@${config.host} "rm -f '${remote}'"`,
      { timeout: 30_000 }
    );
  } finally {
    await cleanupKeyFile(keyFile);
  }
}

/**
 * Generate a download URL for an SSH backup.
 * SSH doesn't have pre-signed URLs, so this returns a placeholder
 * that the API will handle by streaming the file through the server.
 */
export function getSshDownloadPath(config: SshConfig, key: string): string {
  return remotePath(config, key);
}
