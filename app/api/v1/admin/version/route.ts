import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";

const GITHUB_REPO = "joeyyax/vardo";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type CacheEntry = {
  data: VersionResponse;
  fetchedAt: number;
};

type VersionResponse = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
};

// Module-level cache to avoid hammering GitHub API
let cache: CacheEntry | null = null;

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
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

// GET /api/v1/admin/version
export async function GET() {
  try {
    await requireAppAdmin();

    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json(cache.data);
    }

    const currentVersion = process.env.npm_package_version ?? "0.1.0";

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
        const release = await res.json() as { tag_name?: string; html_url?: string };
        if (release.tag_name) {
          latestVersion = release.tag_name.replace(/^v/, "");
        }
        if (release.html_url) {
          releaseUrl = release.html_url;
        }
      }
    } catch {
      // Network error or timeout — return current version as latest so no
      // false-positive update banner appears.
      latestVersion = currentVersion;
    }

    const data: VersionResponse = {
      currentVersion,
      latestVersion,
      hasUpdate: isNewer(latestVersion, currentVersion),
      releaseUrl,
    };

    cache = { data, fetchedAt: now };

    return NextResponse.json(data);
  } catch (error) {
    return handleRouteError(error, "Error checking version");
  }
}
