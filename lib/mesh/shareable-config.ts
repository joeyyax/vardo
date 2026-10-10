import {
  getEmailProviderConfig,
  getBackupStorageConfig,
  getGitHubAppConfig,
  getFeatureFlagsConfig,
  getSslConfig,
  type EmailProvider,
} from "@/lib/system-settings";

/**
 * Config a mesh peer may read from this instance, copied field by field.
 * Never spread a whole config object here: the sources carry secrets.
 */
export type ShareableMeshConfig = {
  email: {
    provider: EmailProvider;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    fromEmail?: string;
    baseUrl?: string;
  } | null;
  backup: {
    type: "s3" | "r2" | "b2" | "ssh";
    bucket?: string;
    region?: string;
    endpoint?: string;
  } | null;
  github: {
    appId: string;
    appSlug: string;
    clientId: string;
  } | null;
  features: Record<string, boolean> | null;
  ssl: {
    activeIssuers: string[];
    concurrentIssuers: number;
    challengeType: "http" | "dns";
    dnsProvider?: "cloudflare";
  };
  /** Sections inherited without their credential. An admin must supply these locally. */
  credentialsRequired: string[];
};

/** Build the credential-free config served to mesh peers. */
export async function buildShareableConfig(): Promise<ShareableMeshConfig> {
  const [email, backup, github, features, ssl] = await Promise.all([
    getEmailProviderConfig(),
    getBackupStorageConfig(),
    getGitHubAppConfig(),
    getFeatureFlagsConfig(),
    getSslConfig(),
  ]);

  const credentialsRequired: string[] = [];
  if (email) credentialsRequired.push("email");
  if (backup) credentialsRequired.push("backup");
  if (github) credentialsRequired.push("github");
  if (ssl.challengeType === "dns") credentialsRequired.push("ssl");

  return {
    email: email
      ? {
          provider: email.provider,
          smtpHost: email.smtpHost,
          smtpPort: email.smtpPort,
          smtpUser: email.smtpUser,
          fromEmail: email.fromEmail,
          baseUrl: email.baseUrl,
        }
      : null,
    backup: backup
      ? {
          type: backup.type,
          bucket: backup.bucket,
          region: backup.region,
          endpoint: backup.endpoint,
        }
      : null,
    github: github
      ? {
          appId: github.appId,
          appSlug: github.appSlug,
          clientId: github.clientId,
        }
      : null,
    features,
    ssl: {
      activeIssuers: ssl.activeIssuers,
      concurrentIssuers: ssl.concurrentIssuers,
      challengeType: ssl.challengeType,
      dnsProvider: ssl.dnsProvider,
    },
    credentialsRequired,
  };
}
