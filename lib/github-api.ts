// Server-side reads of the public Vardo repo on GitHub: authenticated when a credential exists, conditional, rate-limit aware.

import { logger } from "@/lib/logger";

const log = logger.child("github-api");

const API = "https://api.github.com";
const TIMEOUT_MS = 5000;
const TOKEN_MISS_TTL_MS = 5 * 60_000;
const BLOCK_FALLBACK_MS = 15 * 60_000;
const BLOCK_MAX_MS = 70 * 60_000;

export type GitHubCheckError = {
  message: string;
  status: number | null;
  rateLimited: boolean;
  /** When GitHub lets this instance retry, ISO. Null when unknown. */
  resetsAt: string | null;
  at: string;
};

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly rateLimited = false,
    readonly resetsAt: number | null = null,
  ) {
    super(message);
  }
}

export type GitHubResult = { ok: boolean; status: number; text: string };

let lastError: GitHubCheckError | null = null;
let streakLogged = false;
let blockedUntil = 0;
let tokenMissUntil = 0;
const etags = new Map<string, { etag: string; text: string }>();

export function getGitHubCheckError(): GitHubCheckError | null {
  return lastError;
}

export function resetGitHubApiState(): void {
  lastError = null;
  streakLogged = false;
  blockedUntil = 0;
  tokenMissUntil = 0;
  etags.clear();
}

/** Env token first, else a GitHub App installation token (any installation reads public repos). Null when neither exists. */
async function resolveToken(): Promise<string | null> {
  if (Date.now() < tokenMissUntil) return null;
  const env = process.env.VARDO_GITHUB_TOKEN?.trim();
  if (env) return env;
  try {
    const [{ db }, { githubAppInstallations }, { getInstallationToken }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/db/schema"),
      import("@/lib/git-integration/app"),
    ]);
    const row = await db.query.githubAppInstallations.findFirst({
      columns: { installationId: true },
      orderBy: githubAppInstallations.createdAt,
    });
    if (row) return await getInstallationToken(row.installationId);
  } catch (err) {
    log.debug("No GitHub installation token:", err);
  }
  tokenMissUntil = Date.now() + TOKEN_MISS_TTL_MS;
  return null;
}

function fail(error: GitHubError): never {
  lastError = {
    message: error.message,
    status: error.status,
    rateLimited: error.rateLimited,
    resetsAt: error.resetsAt ? new Date(error.resetsAt).toISOString() : null,
    at: new Date().toISOString(),
  };
  if (!streakLogged) {
    streakLogged = true;
    log.warn(`GitHub update check failed: ${error.message}${lastError.resetsAt ? ` (retrying after ${lastError.resetsAt})` : ""}`);
  }
  throw error;
}

function succeed(): void {
  if (lastError) log.info("GitHub update check recovered");
  lastError = null;
  streakLogged = false;
}

function limitFrom(res: Response): { rateLimited: boolean; resetsAt: number | null } {
  const retryAfter = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const rateLimited = res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" || retryAfter > 0;
  if (!rateLimited) return { rateLimited: false, resetsAt: null };
  const now = Date.now();
  const at = retryAfter > 0 ? now + retryAfter * 1000 : reset > 0 ? reset * 1000 : null;
  return { rateLimited: true, resetsAt: at === null ? null : Math.min(Math.max(at, now), now + BLOCK_MAX_MS) };
}

/**
 * GET a path under a repo. `conditional` sends If-None-Match and serves the last body on a 304.
 * Throws GitHubError on rate limits, auth and server failures, and while backing off; other statuses (404) return as results.
 */
export async function githubGet(repo: string, path: string, accept: string, opts: { conditional?: boolean } = {}): Promise<GitHubResult> {
  if (Date.now() < blockedUntil) {
    throw new GitHubError(lastError?.message ?? "GitHub is rate limiting this instance", lastError?.status ?? 403, true, blockedUntil);
  }

  const key = `${repo}${path}|${accept}`;
  const cached = opts.conditional ? etags.get(key) : undefined;
  let token = await resolveToken();

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {
      "User-Agent": "vardo-update-check",
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cached ? { "If-None-Match": cached.etag } : {}),
    };
    let res: Response;
    try {
      res = await fetch(`${API}/repos/${repo}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      return fail(new GitHubError(`Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`, null));
    }

    if (res.status === 304 && cached) {
      succeed();
      return { ok: true, status: 200, text: cached.text };
    }
    if (res.status === 401 && token && attempt === 0) {
      // A rejected credential shouldn't take unauthenticated checks down with it.
      log.warn("GitHub rejected the credential for update checks; retrying without it");
      tokenMissUntil = Date.now() + TOKEN_MISS_TTL_MS;
      token = null;
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      const { rateLimited, resetsAt } = limitFrom(res);
      const until = resetsAt ?? Date.now() + BLOCK_FALLBACK_MS;
      blockedUntil = until;
      return fail(
        new GitHubError(rateLimited ? "GitHub's API rate limit is used up" : `GitHub refused the request (${res.status})`, res.status, rateLimited, until),
      );
    }
    if (res.status === 401 || res.status >= 500) {
      return fail(new GitHubError(`GitHub returned ${res.status}`, res.status));
    }

    const text = await res.text();
    if (res.ok) {
      succeed();
      const etag = res.headers.get("etag");
      if (opts.conditional && etag) etags.set(key, { etag, text });
    }
    return { ok: res.ok, status: res.status, text };
  }
}
