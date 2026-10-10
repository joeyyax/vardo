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
    // Treat as up to date so no false update banner appears.
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

// Commit update check. Installs track main, so a new commit is a new release.

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
  channelCache.clear();
}

// Channel update check: the head of main, or the latest GitHub release, compared with the build commit.

export type UpdateChannelName = "main" | "releases";

export type ChannelUpdate = {
  channel: UpdateChannelName;
  localSha: string;
  /** Full commit the channel points at. */
  targetSha: string;
  /** Release tag, or the short commit on main. */
  targetLabel: string;
  /** Commits the target is ahead of this build. Null when GitHub couldn't compare them. */
  commitsBehind: number | null;
  hasUpdate: boolean;
  url: string;
};

type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

/** Reads GitHub's compare of `<local>...<target>`. */
export function parseCompare(body: unknown): { status: CompareStatus; aheadBy: number } | null {
  if (!body || typeof body !== "object") return null;
  const { status, ahead_by } = body as { status?: unknown; ahead_by?: unknown };
  if (status !== "ahead" && status !== "behind" && status !== "identical" && status !== "diverged") return null;
  return { status, aheadBy: typeof ahead_by === "number" ? ahead_by : 0 };
}

/** Whether the target is news to this build. A release behind the build is not. */
export function channelHasUpdate(localSha: string, targetSha: string, compare: { status: CompareStatus; aheadBy: number } | null): boolean {
  if (targetSha.toLowerCase().startsWith(localSha.toLowerCase())) return false;
  if (!compare) return true;
  return compare.status === "ahead" || (compare.status === "diverged" && compare.aheadBy > 0);
}

const channelCache = new Map<UpdateChannelName, { result: ChannelUpdate | null; checkedAt: number }>();

const GITHUB_HEADERS = { "User-Agent": "vardo-update-check" };

async function github(path: string, accept: string): Promise<Response> {
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    headers: { ...GITHUB_HEADERS, Accept: accept },
    signal: AbortSignal.timeout(5000),
  });
}

async function resolveTarget(channel: UpdateChannelName): Promise<{ sha: string; label: string; url: string } | null> {
  if (channel === "main") {
    const res = await github(`/commits/${UPDATE_BRANCH}`, "application/vnd.github.sha");
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return SHA_RE.test(sha) ? { sha, label: sha.slice(0, 7), url: `https://github.com/${GITHUB_REPO}/commits/${UPDATE_BRANCH}` } : null;
  }
  const rel = await github("/releases/latest", "application/vnd.github+json");
  if (!rel.ok) return null;
  const release = (await rel.json()) as { tag_name?: string; html_url?: string };
  const tag = release.tag_name;
  if (!tag || !/^[\w.-]{1,64}$/.test(tag)) return null;
  const res = await github(`/commits/${encodeURIComponent(tag)}`, "application/vnd.github.sha");
  if (!res.ok) return null;
  const sha = (await res.text()).trim();
  if (!SHA_RE.test(sha)) return null;
  const url = release.html_url?.startsWith("https://") ? release.html_url : `https://github.com/${GITHUB_REPO}/releases`;
  return { sha, label: tag, url };
}

/** The channel's target against the build commit. Null without a build commit or GitHub. Cached like getCommitUpdate. */
export async function getChannelUpdate(channel: UpdateChannelName, opts: { fresh?: boolean } = {}): Promise<ChannelUpdate | null> {
  const localSha = getBuildSha().trim();
  if (!SHA_RE.test(localSha)) return null;

  const now = Date.now();
  const cached = channelCache.get(channel);
  if (cached && !opts.fresh && now - cached.checkedAt < COMMIT_CHECK_TTL_MS) return cached.result;
  channelCache.set(channel, { result: null, checkedAt: now });

  try {
    const target = await resolveTarget(channel);
    if (!target) return null;
    let compare: ReturnType<typeof parseCompare> = null;
    if (!target.sha.toLowerCase().startsWith(localSha.toLowerCase())) {
      const res = await github(`/compare/${localSha}...${target.sha}`, "application/vnd.github+json");
      compare = res.ok ? parseCompare(await res.json()) : null;
    }
    const hasUpdate = channelHasUpdate(localSha, target.sha, compare);
    const result: ChannelUpdate = {
      channel,
      localSha,
      targetSha: target.sha,
      targetLabel: target.label,
      commitsBehind: hasUpdate ? (compare?.aheadBy ?? null) : 0,
      hasUpdate,
      url: target.url,
    };
    channelCache.set(channel, { result, checkedAt: now });
    return result;
  } catch (err) {
    log.debug("Channel update check failed:", err);
    return null;
  }
}
