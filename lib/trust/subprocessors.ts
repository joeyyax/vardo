// Subprocessors Vardo can suggest, and how a new detection meets what the operator already decided.
// Detection only suggests. A row reaches the public page after the operator confirms it.

export type SubprocessorStatus = "suggested" | "confirmed" | "dismissed";

export type Detected = { key: string; name: string; purpose: string; region: string | null };

export type SubprocessorRow = {
  id: string;
  key: string | null;
  name: string;
  purpose: string;
  region: string | null;
  status: SubprocessorStatus;
  detected: boolean;
};

export type Plan = {
  insert: Detected[];
  /** Rows to rewrite from the latest detection. Suggested rows only: a confirmed row keeps the operator's text. */
  refresh: { id: string; name: string; purpose: string; region: string | null }[];
  /** Detected again after being marked gone. */
  back: string[];
  /** Confirmed rows that are no longer detected. They stay listed until the operator confirms the removal. */
  gone: string[];
  /** Suggested or dismissed rows that are no longer detected. */
  drop: string[];
};

export function reconcile(existing: SubprocessorRow[], detected: Detected[]): Plan {
  const byKey = new Map(existing.filter((r) => r.key).map((r) => [r.key!, r]));
  const seen = new Set(detected.map((d) => d.key));
  const plan: Plan = { insert: [], refresh: [], back: [], gone: [], drop: [] };

  for (const d of detected) {
    const row = byKey.get(d.key);
    if (!row) plan.insert.push(d);
    else {
      if (!row.detected) plan.back.push(row.id);
      if (row.status === "suggested" && (row.name !== d.name || row.purpose !== d.purpose || row.region !== d.region)) {
        plan.refresh.push({ id: row.id, name: d.name, purpose: d.purpose, region: d.region });
      }
    }
  }
  for (const row of existing) {
    if (!row.key || seen.has(row.key)) continue;
    if (row.status === "confirmed") {
      if (row.detected) plan.gone.push(row.id);
    } else plan.drop.push(row.id);
  }
  return plan;
}

export type Review = { id: string; title: string; detail: string; href: string; action: string };

/** Subprocessor changes that wait on the operator. */
export function subprocessorReviews(rows: SubprocessorRow[]): Review[] {
  return rows.flatMap((r): Review[] => {
    if (r.status === "suggested") {
      return [{ id: `subprocessor-${r.id}`, title: `Review ${r.name} as a subprocessor`, detail: "Found in your settings. It stays off the public page until you confirm it.", href: "#subprocessors", action: "Review" }];
    }
    if (r.status === "confirmed" && r.key && !r.detected) {
      return [{ id: `subprocessor-${r.id}`, title: `${r.name} is no longer detected`, detail: "It stays on the public page until you confirm the removal.", href: "#subprocessors", action: "Review" }];
    }
    return [];
  });
}

const S3_HOSTS: [RegExp, string][] = [
  [/(^|\.)wasabisys\.com$/, "Wasabi"],
  [/(^|\.)digitaloceanspaces\.com$/, "DigitalOcean Spaces"],
  [/(^|\.)backblazeb2\.com$/, "Backblaze B2"],
  [/(^|\.)r2\.cloudflarestorage\.com$/, "Cloudflare R2"],
  [/(^|\.)your-objectstorage\.com$/, "Hetzner Object Storage"],
  [/(^|\.)amazonaws\.com$/, "Amazon S3"],
];

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["", "localhost", "127.0.0.1", "::1"]);

/** A backup destination as a suggestion. Local targets store on the host and aren't a third party. */
export function detectBackupTarget(target: { type: string; config: unknown }): Detected | null {
  const config = (target.config ?? {}) as { endpoint?: string; region?: string; host?: string };
  const purpose = "Encrypted backups";
  switch (target.type) {
    case "r2":
      return { key: "backup:r2", name: "Cloudflare R2", purpose, region: null };
    case "b2":
      return { key: "backup:b2", name: "Backblaze B2", purpose, region: config.region || null };
    case "s3": {
      const host = hostOf(config.endpoint);
      if (!host) return { key: "backup:s3", name: "Amazon S3", purpose, region: config.region || null };
      const known = S3_HOSTS.find(([re]) => re.test(host));
      return { key: `backup:s3:${host}`, name: known?.[1] ?? host, purpose, region: config.region || null };
    }
    case "ssh": {
      const host = (config.host ?? "").toLowerCase();
      if (LOOPBACK.has(host)) return null;
      return { key: `backup:ssh:${host}`, name: host, purpose, region: null };
    }
    default:
      return null;
  }
}

const EMAIL_NAMES: Record<string, string> = { mailpace: "MailPace", resend: "Resend", postmark: "Postmark", pouch: "Pouch" };

/** The configured email provider as a suggestion. */
export function detectEmail(config: { provider: string; smtpHost?: string; baseUrl?: string } | null): Detected | null {
  if (!config) return null;
  const purpose = "Transactional email";
  if (config.provider === "smtp") {
    const host = config.smtpHost?.trim().toLowerCase();
    return host ? { key: `email:smtp:${host}`, name: host, purpose, region: null } : null;
  }
  const name = EMAIL_NAMES[config.provider];
  return name ? { key: `email:${config.provider}`, name, purpose, region: null } : null;
}

export function detectHostingProvider(hosting: { provider: string; region: string | null } | null): Detected | null {
  if (!hosting) return null;
  const slug = hosting.provider.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { key: `hosting:${slug}`, name: hosting.provider, purpose: "Servers and storage", region: hosting.region };
}

export function detectCloudflare(behind: boolean): Detected | null {
  return behind ? { key: "network:cloudflare", name: "Cloudflare", purpose: "Proxies web traffic to client sites", region: "Global" } : null;
}
