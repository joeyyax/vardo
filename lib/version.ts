import pkg from "@/package.json";
import type { VersionData } from "@/lib/types/version";
import { logger } from "@/lib/logger";

const log = logger.child("version");

const GITHUB_REPO = "joeyyax/vardo";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type CacheEntry = {
  data: VersionData;
  fetchedAt: number;
};

// Module-level cache to avoid hammering GitHub API
let cache: CacheEntry | null = null;

export function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

export async function getVersionData(): Promise<VersionData> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const currentVersion = pkg.version;
  let latestVersion = currentVersion;
  let releaseUrl = `https://github.com/${GITHUB_REPO}/releases`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "vardo-update-check",
        },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (res.ok) {
      const release = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
      };
      if (release.tag_name) {
        latestVersion = release.tag_name.replace(/^v/, "");
      }
      if (release.html_url?.startsWith("https://")) {
        releaseUrl = release.html_url;
      }
    }
  } catch {
    // Network error or timeout — return current version as latest so no
    // false-positive update banner appears.
    latestVersion = currentVersion;
  }

  const data: VersionData = {
    currentVersion,
    latestVersion,
    hasUpdate: isNewer(latestVersion, currentVersion),
    releaseUrl,
  };

  cache = { data, fetchedAt: now };
  return data;
}

// ---------------------------------------------------------------------------
// Commit update check — installs track main, so a new commit is a new release
// ---------------------------------------------------------------------------

const UPDATE_BRANCH = "main";
// Unauthenticated GitHub API allows 60 requests an hour per IP.
const COMMIT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export type CommitUpdate = {
  localSha: string;
  remoteSha: string;
  hasUpdate: boolean;
};

let commitCache: { result: CommitUpdate | null; checkedAt: number } | null = null;

/** Commit the image was built from, inlined by next.config.ts from the GIT_SHA build arg. */
export function getBuildSha(): string {
  return process.env.NEXT_PUBLIC_GIT_SHA ?? "";
}

/**
 * Compare the build commit to the head of main on GitHub. Returns null when
 * the build commit is unknown or GitHub can't be reached.
 */
export async function getCommitUpdate(): Promise<CommitUpdate | null> {
  const localSha = getBuildSha().trim();
  if (!SHA_RE.test(localSha)) {
    log.debug("Update check skipped: no build commit");
    return null;
  }

  const now = Date.now();
  if (commitCache && now - commitCache.checkedAt < COMMIT_CHECK_TTL_MS) {
    return commitCache.result;
  }
  // Failures wait out the TTL too.
  commitCache = { result: null, checkedAt: now };

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/commits/${UPDATE_BRANCH}`,
      {
        headers: {
          Accept: "application/vnd.github.sha",
          "User-Agent": "vardo-update-check",
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) {
      log.debug(`Update check failed: GitHub returned ${res.status}`);
      return null;
    }

    const remoteSha = (await res.text()).trim();
    if (!SHA_RE.test(remoteSha)) {
      log.debug("Update check failed: unexpected GitHub response");
      return null;
    }

    const result: CommitUpdate = {
      localSha,
      remoteSha,
      hasUpdate: !remoteSha.toLowerCase().startsWith(localSha.toLowerCase()),
    };
    commitCache = { result, checkedAt: now };
    return result;
  } catch (err) {
    log.debug("Update check failed:", err);
    return null;
  }
}

export function resetCommitUpdateCache(): void {
  commitCache = null;
}
