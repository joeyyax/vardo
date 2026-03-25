// ---------------------------------------------------------------------------
// Backup Storage Factory
//
// Creates the appropriate BackupStorage adapter based on the backup target's
// type field. The engine calls this once per operation and then works
// exclusively through the BackupStorage interface.
// ---------------------------------------------------------------------------

import type { BackupStorage } from "./storage-port";
import { S3BackupStorage, type S3StorageConfig } from "./storage-s3";
import { SshBackupStorage, type SshConfig } from "./storage-ssh";

type BackupTargetLike = {
  type: "s3" | "r2" | "b2" | "ssh";
  config: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function requireString(
  config: Record<string, unknown>,
  field: string,
  label: string
): string {
  const value = config[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} backup storage requires '${field}' in config`);
  }
  return value;
}

function validateSshConfig(config: Record<string, unknown>): SshConfig {
  const host = requireString(config, "host", "SSH");
  const username = requireString(config, "username", "SSH");
  const path = requireString(config, "path", "SSH");

  const result: SshConfig = { host, username, path };

  if (config.port != null) {
    const port = Number(config.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error("SSH backup storage requires a valid 'port' (1-65535) in config");
    }
    result.port = port;
  }

  if (config.privateKey != null) {
    if (typeof config.privateKey !== "string" || config.privateKey.trim() === "") {
      throw new Error("SSH backup storage requires 'privateKey' to be a non-empty string if provided");
    }
    result.privateKey = config.privateKey;
  }

  return result;
}

function validateS3Config(config: Record<string, unknown>): S3StorageConfig {
  const bucket = requireString(config, "bucket", "S3");
  const region = requireString(config, "region", "S3");
  const accessKeyId = requireString(config, "accessKeyId", "S3");
  const secretAccessKey = requireString(config, "secretAccessKey", "S3");

  const result: S3StorageConfig = { bucket, region, accessKeyId, secretAccessKey };

  if (config.endpoint != null) {
    result.endpoint = String(config.endpoint);
  }
  if (config.prefix != null) {
    result.prefix = String(config.prefix);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBackupStorage(target: BackupTargetLike): BackupStorage {
  if (target.type === "ssh") {
    return new SshBackupStorage(validateSshConfig(target.config));
  }
  // s3, r2, and b2 all use S3-compatible APIs
  return new S3BackupStorage(validateS3Config(target.config));
}
