// ---------------------------------------------------------------------------
// System settings helpers
//
// Reads system_settings rows from the database and decrypts them with
// decryptSystemOrFallback(). Callers should always prefer environment
// variables when set (so Docker / .env deployments keep working as before),
// and fall back to the DB-stored config written by the setup wizard.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { decryptSystemOrFallback } from "@/lib/crypto/encrypt";
import { eq } from "drizzle-orm";

/**
 * Read a system_settings row and decrypt its value.
 * Returns null if the row does not exist.
 */
async function getSystemSettingRaw(key: string): Promise<string | null> {
  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, key),
  });
  if (!row) return null;
  const { content } = decryptSystemOrFallback(row.value);
  return content || null;
}

// ---------------------------------------------------------------------------
// GitHub App
// ---------------------------------------------------------------------------

export type GitHubAppConfig = {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
};

/**
 * Returns the GitHub App configuration. Env vars take precedence; falls back
 * to the setup-wizard row in system_settings.
 */
export async function getGitHubAppConfig(): Promise<GitHubAppConfig | null> {
  // If the core env vars are set, use them directly (no DB hit needed)
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY) {
    return {
      appId: process.env.GITHUB_APP_ID,
      appSlug: process.env.GITHUB_APP_SLUG ?? "",
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      privateKey: Buffer.from(process.env.GITHUB_PRIVATE_KEY, "base64").toString("utf-8"),
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    };
  }

  const raw = await getSystemSettingRaw("github_app");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as GitHubAppConfig;
  } catch {
    console.error("[system-settings] Failed to parse github_app config");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email provider
// ---------------------------------------------------------------------------

export type EmailProviderConfig = {
  provider: "smtp" | "mailpace" | "resend";
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
};

/**
 * Returns the email provider configuration. Env vars take precedence; falls
 * back to the setup-wizard row in system_settings.
 */
export async function getEmailProviderConfig(): Promise<EmailProviderConfig | null> {
  // Env-var configured — no DB hit needed
  if (process.env.MAILPACE_API_TOKEN) {
    return {
      provider: "mailpace",
      apiKey: process.env.MAILPACE_API_TOKEN,
      fromEmail: process.env.EMAIL_FROM,
      fromName: undefined,
    };
  }

  const raw = await getSystemSettingRaw("email_provider");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as EmailProviderConfig;
  } catch {
    console.error("[system-settings] Failed to parse email_provider config");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backup storage
// ---------------------------------------------------------------------------

export type BackupStorageConfig = {
  type: "s3" | "r2" | "b2" | "ssh";
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
};

/**
 * Returns the backup storage configuration from the setup-wizard row in
 * system_settings. (No env-var equivalent exists for backup storage.)
 */
export async function getBackupStorageConfig(): Promise<BackupStorageConfig | null> {
  const raw = await getSystemSettingRaw("backup_storage");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as BackupStorageConfig;
  } catch {
    console.error("[system-settings] Failed to parse backup_storage config");
    return null;
  }
}
