/**
 * Static guidance data for setup wizard and admin settings.
 * Shared between the setup wizard steps and the admin settings pages
 * so users see the same helpful context in both places.
 */

// ---------------------------------------------------------------------------
// GitHub App
// ---------------------------------------------------------------------------

export const GITHUB_GUIDE = {
  createAppUrl: "https://github.com/settings/apps/new",
  docsUrl: "https://docs.github.com/en/apps/creating-github-apps",
  permissions: [
    { scope: "Repository contents", access: "Read-only" },
    { scope: "Pull requests", access: "Read & write" },
    { scope: "Webhooks", access: "Enabled" },
  ] as const,
  steps: [
    "Create a new GitHub App at github.com/settings/apps/new",
    "Copy the App ID and slug from the app's General page",
    "Scroll to \"Private keys\" and click Generate a private key — save the .pem file",
    "Copy the Client ID and generate a Client secret under OAuth credentials",
    "Set the Webhook URL and secret (shown below), then activate webhooks",
  ] as const,
  fieldHints: {
    appId: "Numeric ID shown at the top of your GitHub App's General page",
    appSlug: "The URL-friendly name — visible in the app URL: github.com/apps/{slug}",
    clientId: "Found under \"OAuth credentials\" on the app's General page",
    clientSecret: "Generate under \"Client secrets\" — only shown once",
    privateKey: "Download the .pem file from \"Private keys\" and paste the full contents",
    webhookSecret: "Must match the secret configured in your GitHub App's webhook settings",
  },
} as const;

export function getWebhookUrl(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/api/webhooks/github`;
}

// ---------------------------------------------------------------------------
// Email Providers
// ---------------------------------------------------------------------------

export type EmailProviderGuide = {
  name: string;
  signupUrl: string;
  dashboardUrl: string;
  keyLocation: string;
  description: string;
};

export const EMAIL_PROVIDER_GUIDES: Record<string, EmailProviderGuide> = {
  resend: {
    name: "Resend",
    signupUrl: "https://resend.com/signup",
    dashboardUrl: "https://resend.com/api-keys",
    keyLocation: "Dashboard → API Keys → Create API Key",
    description: "API-first email with bounce handling and delivery analytics.",
  },
  postmark: {
    name: "Postmark",
    signupUrl: "https://account.postmarkapp.com/sign_up",
    dashboardUrl: "https://account.postmarkapp.com/servers",
    keyLocation: "Select your Server → API Tokens tab → copy the Server API Token",
    description: "Fast transactional email — reliable delivery and per-message logging.",
  },
  mailpace: {
    name: "Mailpace",
    signupUrl: "https://app.mailpace.com/users/sign_up",
    dashboardUrl: "https://app.mailpace.com",
    keyLocation: "Domain Settings → API Tokens → copy your Organization API Token",
    description: "Privacy-focused email sending with no tracking pixels or link rewriting.",
  },
  smtp: {
    name: "SMTP",
    signupUrl: "",
    dashboardUrl: "",
    keyLocation: "",
    description: "Direct SMTP connection — no delivery tracking or bounce detection.",
  },
} as const;

export const SMTP_PRESETS = [
  { label: "Gmail", host: "smtp.gmail.com", port: "587", note: "Requires an App Password — google.com/apppasswords" },
  { label: "Fastmail", host: "smtp.fastmail.com", port: "465", note: "Use an app-specific password from Settings → Privacy & Security" },
  { label: "Outlook", host: "smtp.office365.com", port: "587", note: "Requires an app password — account.microsoft.com/security" },
] as const;

// ---------------------------------------------------------------------------
// Backup Storage
// ---------------------------------------------------------------------------

export type BackupProviderGuide = {
  name: string;
  consoleUrl: string;
  createBucketUrl: string;
  credentialSteps: string;
  bucketSettings: string;
  requiredPermissions: string;
};

export const BACKUP_PROVIDER_GUIDES: Record<string, BackupProviderGuide> = {
  s3: {
    name: "AWS S3",
    consoleUrl: "https://s3.console.aws.amazon.com/s3/buckets",
    createBucketUrl: "https://s3.console.aws.amazon.com/s3/bucket/create",
    credentialSteps: "IAM Console → Users → Create user → Attach policy → Security credentials → Create access key",
    bucketSettings: "Block all public access ON, versioning optional, default encryption recommended",
    requiredPermissions: "s3:PutObject, s3:GetObject, s3:ListBucket, s3:DeleteObject — scoped to your backup bucket",
  },
  r2: {
    name: "Cloudflare R2",
    consoleUrl: "https://dash.cloudflare.com/?to=/:account/r2",
    createBucketUrl: "https://dash.cloudflare.com/?to=/:account/r2/new",
    credentialSteps: "R2 Overview → Manage R2 API Tokens → Create API token → Object Read & Write on the specific bucket",
    bucketSettings: "Create a private bucket. Account ID is in the right sidebar of the R2 overview page.",
    requiredPermissions: "Object Read & Write scoped to the backup bucket",
  },
  b2: {
    name: "Backblaze B2",
    consoleUrl: "https://secure.backblaze.com/b2_buckets.htm",
    createBucketUrl: "https://secure.backblaze.com/b2_buckets.htm",
    credentialSteps: "Application Keys → Add a New Application Key → scope to your backup bucket",
    bucketSettings: "Create a new private bucket. Copy the bucket name (not the ID) into the field above.",
    requiredPermissions: "Read and Write access scoped to the backup bucket",
  },
} as const;

// ---------------------------------------------------------------------------
// Domain / DNS
// ---------------------------------------------------------------------------

export type DnsRecord = {
  type: string;
  name: string;
  value: string;
};

export function getDnsRecords(baseDomain: string, serverIp: string): DnsRecord[] {
  return [
    { type: "A", name: baseDomain || "your-domain.com", value: serverIp || "your server IP" },
    { type: "A", name: `*.${baseDomain || "your-domain.com"}`, value: serverIp || "your server IP" },
  ];
}

export function getDnsProviderHint(nameservers: string[]): { provider: string; consoleUrl: string } | null {
  const joined = nameservers.join(" ").toLowerCase();
  if (joined.includes("cloudflare")) {
    return { provider: "Cloudflare", consoleUrl: "https://dash.cloudflare.com" };
  }
  if (joined.includes("awsdns") || joined.includes("amazonaws")) {
    return { provider: "AWS Route 53", consoleUrl: "https://console.aws.amazon.com/route53" };
  }
  if (joined.includes("vercel")) {
    return { provider: "Vercel", consoleUrl: "https://vercel.com/dashboard/domains" };
  }
  if (joined.includes("digitalocean")) {
    return { provider: "DigitalOcean", consoleUrl: "https://cloud.digitalocean.com/networking/domains" };
  }
  return null;
}
