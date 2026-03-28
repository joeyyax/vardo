import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// parseVersion / isNewer — pure version comparison helpers
// ---------------------------------------------------------------------------
// Logic extracted from app/api/v1/admin/version/route.ts for unit testing
// without requiring Next.js plumbing, DB access, or network calls.

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

describe("parseVersion", () => {
  it("parses a standard semver string", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  it("strips a leading v-prefix", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
  });

  it("treats non-numeric segments as 0", () => {
    expect(parseVersion("1.alpha.3")).toEqual([1, 0, 3]);
  });

  it("handles a single-segment version", () => {
    expect(parseVersion("5")).toEqual([5]);
  });

  it("handles a two-segment version", () => {
    expect(parseVersion("1.10")).toEqual([1, 10]);
  });
});

describe("isNewer", () => {
  it("returns true when latest is a higher patch", () => {
    expect(isNewer("1.2.4", "1.2.3")).toBe(true);
  });

  it("returns true when latest is a higher minor", () => {
    expect(isNewer("1.3.0", "1.2.9")).toBe(true);
  });

  it("returns true when latest is a higher major", () => {
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns false when current is ahead of latest", () => {
    expect(isNewer("1.2.2", "1.2.3")).toBe(false);
  });

  it("handles v-prefix on both sides", () => {
    expect(isNewer("v1.3.0", "v1.2.0")).toBe(true);
  });

  it("handles v-prefix only on latest", () => {
    expect(isNewer("v1.3.0", "1.2.0")).toBe(true);
  });

  it("handles length mismatch — shorter latest treated as padded with zeros", () => {
    // "1.2" vs "1.2.0" should be equal
    expect(isNewer("1.2", "1.2.0")).toBe(false);
  });

  it("handles length mismatch — shorter current treated as padded with zeros", () => {
    // "1.2.1" vs "1.2" — latest has extra patch
    expect(isNewer("1.2.1", "1.2")).toBe(true);
  });

  it("returns false when both versions are 0.1.0", () => {
    // Fallback version should never trigger a banner against itself
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Network-error silent-failure path
// ---------------------------------------------------------------------------
// When the GitHub API fetch throws, the route sets latestVersion = currentVersion
// so hasUpdate is always false — no false-positive banner.

type VersionData = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
};

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
};

type FetchLike = (url: string, opts: RequestInit) => Promise<Response>;

const GITHUB_REPO = "joeyyax/vardo";

async function fetchVersionData(
  currentVersion: string,
  fetchImpl: FetchLike
): Promise<VersionData> {
  let latestVersion = currentVersion;
  let releaseUrl = `https://github.com/${GITHUB_REPO}/releases`;

  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "vardo-update-check",
        },
      }
    );

    if (res.ok) {
      const release = (await res.json()) as GithubRelease;
      if (release.tag_name) {
        latestVersion = release.tag_name.replace(/^v/, "");
      }
      if (release.html_url?.startsWith("https://")) {
        releaseUrl = release.html_url;
      }
    }
  } catch {
    // Network error — fall back silently
    latestVersion = currentVersion;
  }

  return {
    currentVersion,
    latestVersion,
    hasUpdate: isNewer(latestVersion, currentVersion),
    releaseUrl,
  };
}

describe("network-error silent-failure", () => {
  it("returns hasUpdate: false when fetch throws", async () => {
    const failingFetch = vi
      .fn()
      .mockRejectedValue(new Error("Network error")) as unknown as FetchLike;

    const result = await fetchVersionData("1.2.3", failingFetch);

    expect(result.hasUpdate).toBe(false);
    expect(result.latestVersion).toBe("1.2.3");
    expect(result.currentVersion).toBe("1.2.3");
  });

  it("returns hasUpdate: false when fetch returns a non-ok response", async () => {
    const errorResponse = {
      ok: false,
      json: vi.fn(),
    } as unknown as Response;
    const fetchWithError = vi
      .fn()
      .mockResolvedValue(errorResponse) as unknown as FetchLike;

    const result = await fetchVersionData("1.2.3", fetchWithError);

    expect(result.hasUpdate).toBe(false);
    expect(errorResponse.json).not.toHaveBeenCalled();
  });

  it("returns hasUpdate: true when a newer release is found", async () => {
    const successResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        tag_name: "v1.3.0",
        html_url: "https://github.com/joeyyax/vardo/releases/tag/v1.3.0",
      }),
    } as unknown as Response;
    const fetchWithRelease = vi
      .fn()
      .mockResolvedValue(successResponse) as unknown as FetchLike;

    const result = await fetchVersionData("1.2.3", fetchWithRelease);

    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe("1.3.0");
    expect(result.releaseUrl).toBe(
      "https://github.com/joeyyax/vardo/releases/tag/v1.3.0"
    );
  });

  it("ignores release URL that does not start with https://", async () => {
    const successResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        tag_name: "v1.3.0",
        html_url: "javascript:alert(1)",
      }),
    } as unknown as Response;
    const fetchWithBadUrl = vi
      .fn()
      .mockResolvedValue(successResponse) as unknown as FetchLike;

    const result = await fetchVersionData("1.2.3", fetchWithBadUrl);

    expect(result.releaseUrl).toBe(
      `https://github.com/${GITHUB_REPO}/releases`
    );
  });
});

// ---------------------------------------------------------------------------
// Module-level cache TTL behavior
// ---------------------------------------------------------------------------
// The route caches the GitHub response for CACHE_TTL_MS to stay within rate
// limits. A cache hit within the TTL skips the fetch; after expiry a fresh
// fetch is issued.

const CACHE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = {
  data: VersionData;
  fetchedAt: number;
};

function isCacheValid(
  entry: CacheEntry | null,
  now: number
): entry is CacheEntry {
  return entry !== null && now - entry.fetchedAt < CACHE_TTL_MS;
}

async function fetchVersionDataWithCache(
  currentVersion: string,
  fetchImpl: FetchLike,
  cache: { entry: CacheEntry | null },
  now: number
): Promise<VersionData> {
  if (isCacheValid(cache.entry, now)) {
    return cache.entry.data;
  }

  const data = await fetchVersionData(currentVersion, fetchImpl);
  cache.entry = { data, fetchedAt: now };
  return data;
}

describe("cache TTL behavior", () => {
  let fetchMock: FetchLike;
  let cache: { entry: CacheEntry | null };

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        tag_name: "v1.3.0",
        html_url: "https://github.com/joeyyax/vardo/releases/tag/v1.3.0",
      }),
    } as unknown as Response) as unknown as FetchLike;
    cache = { entry: null };
  });

  it("fetches on first call when cache is empty", async () => {
    await fetchVersionDataWithCache("1.2.3", fetchMock, cache, Date.now());
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(1);
  });

  it("returns cached data without fetching on a second call within TTL", async () => {
    const now = Date.now();
    await fetchVersionDataWithCache("1.2.3", fetchMock, cache, now);
    await fetchVersionDataWithCache("1.2.3", fetchMock, cache, now + 1000); // 1 s later
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL has expired", async () => {
    const now = Date.now();
    await fetchVersionDataWithCache("1.2.3", fetchMock, cache, now);
    await fetchVersionDataWithCache(
      "1.2.3",
      fetchMock,
      cache,
      now + CACHE_TTL_MS + 1
    );
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(2);
  });

  it("cache hit returns the same data object as the original fetch", async () => {
    const now = Date.now();
    const first = await fetchVersionDataWithCache(
      "1.2.3",
      fetchMock,
      cache,
      now
    );
    const second = await fetchVersionDataWithCache(
      "1.2.3",
      fetchMock,
      cache,
      now + 100
    );
    expect(second).toBe(first);
  });
});
