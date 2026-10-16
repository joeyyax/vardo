import pkg from "@/package.json";
import type { VersionData } from "@/lib/types/version";
import type { UpdateCommit } from "@/lib/bus/events";
import { logger } from "@/lib/logger";
import { GitHubError, githubGet, resetGitHubApiState } from "@/lib/github-api";

const log = logger.child("version");

export const GITHUB_REPO = "joeyyax/vardo";
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
    const res = await githubGet(GITHUB_REPO, "/releases/latest", "application/vnd.github+json", { conditional: true });

    if (res.ok) {
      const release = JSON.parse(res.text) as {
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

const UPDATE_BRANCH = "main";
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Commit the image was built from, inlined by next.config.ts from the GIT_SHA build arg. */
export function getBuildSha(): string {
  return process.env.NEXT_PUBLIC_GIT_SHA ?? "";
}

export function resetCommitUpdateCache(): void {
  channelCache.clear();
  resetGitHubApiState();
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
  /** The release page, or the branch's commits. */
  url: string;
  /** Newest first, at most COMPARE_COMMITS. */
  commits?: UpdateCommit[];
  /** The GitHub compare page, when GitHub compared the two. */
  compareUrl?: string;
  /** Release notes, for the releases channel. */
  releaseNotes?: string;
};

type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

/** Commits past the listed ones, when some are listed and more exist. */
export function moreCommits(total: number | null | undefined, listed: number): { moreCommits?: number } {
  return listed > 0 && total && total > listed ? { moreCommits: total - listed } : {};
}

/** Commits an update email lists. */
export const COMPARE_COMMITS = 10;

export type Compare = { status: CompareStatus; aheadBy: number; commits: UpdateCommit[]; url?: string };

function compareCommit(raw: unknown): UpdateCommit | null {
  if (!raw || typeof raw !== "object") return null;
  const { sha, commit, author } = raw as { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown } }; author?: { login?: unknown } | null };
  if (typeof sha !== "string" || !SHA_RE.test(sha)) return null;
  const message = typeof commit?.message === "string" ? commit.message : "";
  const name = typeof commit?.author?.name === "string" ? commit.author.name : typeof author?.login === "string" ? author.login : undefined;
  return { sha: sha.slice(0, 7), subject: message.split("\n")[0].trim(), ...(name ? { author: name } : {}) };
}

/** Reads GitHub's compare of `<local>...<target>`: status, distance and the newest commits. */
export function parseCompare(body: unknown): Compare | null {
  if (!body || typeof body !== "object") return null;
  const { status, ahead_by, commits, html_url } = body as { status?: unknown; ahead_by?: unknown; commits?: unknown; html_url?: unknown };
  if (status !== "ahead" && status !== "behind" && status !== "identical" && status !== "diverged") return null;
  const list = Array.isArray(commits) ? commits.map(compareCommit).filter((c): c is UpdateCommit => c !== null) : [];
  return {
    status,
    aheadBy: typeof ahead_by === "number" ? ahead_by : 0,
    // GitHub lists oldest first.
    commits: list.reverse().slice(0, COMPARE_COMMITS),
    ...(typeof html_url === "string" && html_url.startsWith("https://") ? { url: html_url } : {}),
  };
}

/** Whether the target is news to this build. A release behind the build is not. */
export function channelHasUpdate(localSha: string, targetSha: string, compare: Pick<Compare, "status" | "aheadBy"> | null): boolean {
  if (targetSha.toLowerCase().startsWith(localSha.toLowerCase())) return false;
  if (!compare) return true;
  return compare.status === "ahead" || (compare.status === "diverged" && compare.aheadBy > 0);
}

const channelCache = new Map<UpdateChannelName, { check: ChannelCheck; checkedAt: number }>();
const CHANNEL_CHECK_TTL_MS = 5 * 60_000;

export function invalidateChannelUpdate(channel?: UpdateChannelName): void {
  if (channel) channelCache.delete(channel);
  else channelCache.clear();
}

const github = (path: string, accept: string, conditional = false) => githubGet(GITHUB_REPO, path, accept, { conditional });

/** The release channel of a repo with no published release. */
const NO_RELEASE = "no-release";

async function resolveTarget(channel: UpdateChannelName): Promise<{ sha: string; label: string; url: string; notes?: string } | typeof NO_RELEASE | null> {
  if (channel === "main") {
    const res = await github(`/commits/${UPDATE_BRANCH}`, "application/vnd.github.sha", true);
    if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} for ${UPDATE_BRANCH}`, res.status);
    const sha = res.text.trim();
    return SHA_RE.test(sha) ? { sha, label: sha.slice(0, 7), url: `https://github.com/${GITHUB_REPO}/commits/${UPDATE_BRANCH}` } : null;
  }
  const rel = await github("/releases/latest", "application/vnd.github+json", true);
  if (rel.status === 404) return NO_RELEASE;
  if (!rel.ok) throw new GitHubError(`GitHub returned ${rel.status} for the latest release`, rel.status);
  const release = JSON.parse(rel.text) as { tag_name?: string; html_url?: string; body?: string };
  const tag = release.tag_name;
  if (!tag || !/^[\w.-]{1,64}$/.test(tag)) return null;
  const res = await github(`/commits/${encodeURIComponent(tag)}`, "application/vnd.github.sha", true);
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} for release ${tag}`, res.status);
  const sha = res.text.trim();
  if (!SHA_RE.test(sha)) return null;
  const url = release.html_url?.startsWith("https://") ? release.html_url : `https://github.com/${GITHUB_REPO}/releases`;
  const notes = typeof release.body === "string" && release.body.trim() ? release.body.trim() : undefined;
  return { sha, label: tag, url, ...(notes ? { notes } : {}) };
}

/** GitHub's compare of two commits. Null when GitHub can't be reached or doesn't know them. */
export async function fetchCompare(base: string, head: string): Promise<Compare | null> {
  if (!SHA_RE.test(base) || !SHA_RE.test(head)) return null;
  try {
    const res = await github(`/compare/${base}...${head}`, "application/vnd.github+json");
    return res.ok ? parseCompare(JSON.parse(res.text)) : null;
  } catch (err) {
    log.debug("Compare failed:", err);
    return null;
  }
}

/** The channel's target against the build commit. Null without a build commit, with no release yet, or when the check fails (see getGitHubCheckError). Cached five minutes. */
export async function getChannelUpdate(channel: UpdateChannelName, opts: { fresh?: boolean } = {}): Promise<ChannelUpdate | null> {
  return (await getChannelCheck(channel, opts)).update;
}

export type ChannelCheck = { update: ChannelUpdate | null; noRelease: boolean };

/** getChannelUpdate, plus whether the releases channel has nothing published yet. */
export async function getChannelCheck(channel: UpdateChannelName, opts: { fresh?: boolean } = {}): Promise<ChannelCheck> {
  const localSha = getBuildSha().trim();
  if (!SHA_RE.test(localSha)) return { update: null, noRelease: false };

  const now = Date.now();
  const cached = channelCache.get(channel);
  if (cached && !opts.fresh && now - cached.checkedAt < CHANNEL_CHECK_TTL_MS) return cached.check;
  channelCache.set(channel, { check: { update: null, noRelease: false }, checkedAt: now });

  try {
    const target = await resolveTarget(channel);
    if (target === NO_RELEASE) {
      const check = { update: null, noRelease: true };
      channelCache.set(channel, { check, checkedAt: now });
      return check;
    }
    if (!target) return { update: null, noRelease: false };
    let compare: Compare | null = null;
    if (!target.sha.toLowerCase().startsWith(localSha.toLowerCase())) {
      const res = await github(`/compare/${localSha}...${target.sha}`, "application/vnd.github+json");
      compare = res.ok ? parseCompare(JSON.parse(res.text)) : null;
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
      commits: hasUpdate ? (compare?.commits ?? []) : [],
      ...(compare?.url ? { compareUrl: compare.url } : {}),
      ...(target.notes ? { releaseNotes: target.notes } : {}),
    };
    const check = { update: result, noRelease: false };
    channelCache.set(channel, { check, checkedAt: now });
    return check;
  } catch (err) {
    log.debug("Channel update check failed:", err);
    return { update: null, noRelease: false };
  }
}
