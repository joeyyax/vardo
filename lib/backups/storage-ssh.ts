// SSH/SCP backup storage adapter.

import { stat, writeFile as fsWriteFile, unlink } from "fs/promises";
import { nanoid } from "nanoid";
import { ArchiveMissingError, type BackupStorage, type StoredObject } from "./storage-port";
import { execFileAsync } from "@/lib/utils/exec";

export type SshConfig = {
  host: string;
  port?: number;
  username: string;
  /** PEM-encoded private key. If omitted, uses the system's default SSH key. */
  privateKey?: string;
  /** Remote directory path where backups are stored. */
  path: string;
};

/** Single-quote a string for a remote shell command. */
function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Build scp and ssh flags, writing the private key to a temp file if provided. */
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
  if (!keyFile) return;
  try {
    await unlink(keyFile);
  } catch {
    // best effort
  }
}

/** Join remote path segments, normalizing slashes. */
function remotePath(config: SshConfig, key: string): string {
  const base = config.path.replace(/\/+$/, "");
  return `${base}/${key}`;
}

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
        "mkdir", "-p", shellEscape(remoteDir),
      ],
      { timeout: 30_000 }
    );
  } finally {
    await cleanupKeyFile(keyFile);
  }
}

export class SshBackupStorage implements BackupStorage {
  private config: SshConfig;

  constructor(config: SshConfig) {
    this.config = config;
  }

  async upload(key: string, filePath: string): Promise<{ sizeBytes: number }> {
    const remote = remotePath(this.config, key);
    const remoteDir = remote.substring(0, remote.lastIndexOf("/"));

    await ensureRemoteDir(this.config, remoteDir);

    const { scpFlags, keyFile } = await buildFlags(this.config);
    try {
      await execFileAsync(
        "scp",
        [
          ...scpFlags,
          "--",
          filePath,
          `${this.config.username}@${this.config.host}:${shellEscape(remote)}`,
        ],
        { timeout: 600_000 }
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
          `${this.config.username}@${this.config.host}:${shellEscape(remote)}`,
          destPath,
        ],
        { timeout: 600_000 }
      );
    } catch (err) {
      // scp exits 1 for every failure, so the reason only exists as text.
      const stderr = (err as { stderr?: unknown }).stderr;
      if (typeof stderr === "string" && /no such file or directory/i.test(stderr)) {
        throw new ArchiveMissingError();
      }
      throw err;
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
          "rm", "-f", shellEscape(remote),
        ],
        { timeout: 30_000 }
      );
    } finally {
      await cleanupKeyFile(keyFile);
    }
  }

  /** Needs GNU find on the remote host. */
  async list(prefix: string): Promise<StoredObject[]> {
    const base = this.config.path.replace(/\/+$/, "");
    const dir = remotePath(this.config, prefix.slice(0, prefix.lastIndexOf("/") + 1));
    const { sshFlags, keyFile } = await buildFlags(this.config);
    try {
      const { stdout } = await execFileAsync(
        "ssh",
        [
          ...sshFlags,
          "--",
          `${this.config.username}@${this.config.host}`,
          "find", shellEscape(dir), "-type", "f", "-printf", shellEscape("%s %T@ %p\\n"),
          "2>/dev/null", "||", "true",
        ],
        { timeout: 60_000 },
      );
      const found: StoredObject[] = [];
      for (const line of String(stdout).split("\n")) {
        const match = line.match(/^(\d+) ([\d.]+) (.+)$/);
        if (!match || !match[3].startsWith(`${base}/`)) continue;
        const key = match[3].slice(base.length + 1);
        if (!key.startsWith(prefix)) continue;
        found.push({ key, sizeBytes: Number(match[1]), modifiedAt: new Date(Number(match[2]) * 1000) });
      }
      return found;
    } finally {
      await cleanupKeyFile(keyFile);
    }
  }

  // No getDownloadUrl: SSH can't pre-sign URLs.
}
