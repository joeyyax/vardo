// ---------------------------------------------------------------------------
// GlitchTip HTTP client — manages projects and queries error data
//
// The internal URL (for server→container communication) is always the stable
// Docker hostname: http://vardo-glitchtip:8000. The API token and optional
// browser-accessible public URL are read from encrypted system settings
// (admin UI or vardo.yml / vardo.secrets.yml).
// ---------------------------------------------------------------------------

import { logger } from "@/lib/logger";

const log = logger.child("error-tracking");

/** Default internal URL for server-side API calls (Docker DNS). */
const DEFAULT_GLITCHTIP_URL = "http://vardo-glitchtip:8000";

/** Resolved config — lazily loaded from system settings, cached for 30s. */
let configCache: { url: string; apiToken: string; publicUrl: string; expiresAt: number } | null = null;

async function getConfig(): Promise<{ url: string; apiToken: string; publicUrl: string }> {
  if (configCache && Date.now() < configCache.expiresAt) {
    return configCache;
  }
  const { getErrorTrackingConfig } = await import("@/lib/system-settings");
  const config = await getErrorTrackingConfig();
  const url = config?.url ?? DEFAULT_GLITCHTIP_URL;
  const result = {
    url,
    apiToken: config?.apiToken ?? "",
    publicUrl: config?.publicUrl ?? url,
    expiresAt: Date.now() + 30_000,
  };
  configCache = result;
  return result;
}

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

let glitchtipReady: boolean | null = null;
let lastCheck = 0;

/** Check if GlitchTip is reachable. Cached for 30s. */
export async function isGlitchTipAvailable(): Promise<boolean> {
  const now = Date.now();
  if (glitchtipReady !== null && now - lastCheck < 30_000) return glitchtipReady;
  try {
    const { url: baseUrl } = await getConfig();
    const res = await fetch(`${baseUrl}/api/0/`, {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    glitchtipReady = res.ok;
  } catch {
    glitchtipReady = false;
  }
  lastCheck = now;
  return glitchtipReady;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GlitchTipIssue = {
  id: number;
  title: string;
  culprit: string;
  level: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
  type: string;
  metadata: {
    type?: string;
    value?: string;
    filename?: string;
    function?: string;
  };
  permalink: string | null;
};

export type GlitchTipEvent = {
  eventID: string;
  title: string;
  message: string;
  dateCreated: string;
  tags: { key: string; value: string }[];
  entries: {
    type: string;
    data: unknown;
  }[];
};

type GlitchTipProject = {
  id: number;
  slug: string;
  name: string;
};

type GlitchTipOrganization = {
  id: number;
  slug: string;
  name: string;
};

type GlitchTipDSNKey = {
  dsn: { public: string; secret: string };
};

// ---------------------------------------------------------------------------
// Organization helpers
// ---------------------------------------------------------------------------

/** Get or create the default GlitchTip organization for Vardo. */
async function ensureOrganization(): Promise<GlitchTipOrganization> {
  const orgs = await apiFetch<GlitchTipOrganization[]>("/api/0/organizations/");

  const existing = orgs.find((o) => o.slug === "vardo");
  if (existing) return existing;

  return apiFetch<GlitchTipOrganization>("/api/0/organizations/", {
    method: "POST",
    body: JSON.stringify({ name: "Vardo", slug: "vardo" }),
  });
}

// ---------------------------------------------------------------------------
// Project management
// ---------------------------------------------------------------------------

/** Get or create a GlitchTip project for a Vardo app and return its DSN. */
export async function ensureProjectDSN(appName: string): Promise<string | null> {
  try {
    const org = await ensureOrganization();
    const orgSlug = org.slug;

    // Check for existing project
    const projects = await apiFetch<GlitchTipProject[]>(`/api/0/organizations/${orgSlug}/projects/`);
    let project = projects.find((p) => p.slug === appName);

    if (!project) {
      // Create a new project — GlitchTip requires a team
      const teams = await apiFetch<{ slug: string }[]>(`/api/0/organizations/${orgSlug}/teams/`);
      let teamSlug = teams[0]?.slug;

      if (!teamSlug) {
        const team = await apiFetch<{ slug: string }>(`/api/0/organizations/${orgSlug}/teams/`, {
          method: "POST",
          body: JSON.stringify({ slug: "default" }),
        });
        teamSlug = team.slug;
      }

      project = await apiFetch<GlitchTipProject>(`/api/0/teams/${orgSlug}/${teamSlug}/projects/`, {
        method: "POST",
        body: JSON.stringify({ name: appName, slug: appName }),
      });

      log.info(`Created GlitchTip project "${appName}"`);
    }

    // Get the DSN
    const keys = await apiFetch<GlitchTipDSNKey[]>(`/api/0/projects/${orgSlug}/${project.slug}/keys/`);
    return keys[0]?.dsn?.public ?? null;
  } catch (err) {
    log.error(`Failed to ensure GlitchTip project for "${appName}":`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Issue / event queries
// ---------------------------------------------------------------------------

/** List recent issues for a GlitchTip project. */
export async function listIssues(appName: string, opts?: { limit?: number }): Promise<GlitchTipIssue[]> {
  const org = await ensureOrganization();
  const limit = opts?.limit ?? 25;

  try {
    const issues = await apiFetch<GlitchTipIssue[]>(
      `/api/0/projects/${org.slug}/${appName}/issues/?limit=${limit}`,
    );

    // Rewrite permalinks to use the browser-accessible URL.
    // GlitchTip permalinks use its internal GLITCHTIP_DOMAIN which may be
    // a Docker hostname not reachable from the browser.
    const config = await getConfig();
    if (config.publicUrl !== config.url) {
      const publicUrl = config.publicUrl;
      for (const issue of issues) {
        if (issue.permalink) {
          try {
            const parsed = new URL(issue.permalink);
            const pub = new URL(publicUrl);
            parsed.protocol = pub.protocol;
            parsed.host = pub.host;
            issue.permalink = parsed.toString();
          } catch {
            // leave permalink as-is if parsing fails
          }
        }
      }
    }

    return issues;
  } catch {
    return [];
  }
}

/** Get a single issue's latest event (with stack trace). */
export async function getIssueLatestEvent(issueId: number): Promise<GlitchTipEvent | null> {
  try {
    return await apiFetch<GlitchTipEvent>(`/api/0/issues/${issueId}/events/latest/`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { url: baseUrl, apiToken } = await getConfig();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (apiToken) {
    headers["Authorization"] = `Bearer ${apiToken}`;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GlitchTip API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}
