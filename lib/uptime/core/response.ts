// What a response's headers say about who answered: Vardo's own catch-all, or a cache in front of the app.

/** Vardo's console sets this on the page it serves for a host with no route. Keep in step with next.config.ts. */
export const NO_ROUTE_HEADER = "x-vardo-route";
export const NO_ROUTE_VALUE = "none";

type HeaderReader = { get(name: string): string | null };

/** True when Vardo's catch-all answered instead of an app. */
export const isNoRoute = (headers: HeaderReader): boolean => headers.get(NO_ROUTE_HEADER)?.trim().toLowerCase() === NO_ROUTE_VALUE;

/** Caches a check can be answered by. */
export const CACHES = ["cloudflare", "vercel", "cloudfront", "fastly", "proxy", "cache"] as const;
export type CacheName = (typeof CACHES)[number];

const word = (headers: HeaderReader, name: string) => headers.get(name)?.trim().toUpperCase() ?? null;

/**
 * The cache that answered, or null when the origin did. A cache's own status header decides when present, so
 * `cf-cache-status: DYNAMIC` or `MISS` reads as the origin even with an `age` header passed through. `age` alone counts only without one.
 */
export function cacheOf(headers: HeaderReader): CacheName | null {
  const cf = word(headers, "cf-cache-status");
  if (cf) return ["HIT", "STALE", "REVALIDATED", "UPDATING"].includes(cf) ? "cloudflare" : null;
  const vercel = word(headers, "x-vercel-cache");
  if (vercel) return ["HIT", "STALE", "PRERENDER"].includes(vercel) ? "vercel" : null;
  const xCache = word(headers, "x-cache");
  if (xCache) {
    // CloudFront: "Hit from cloudfront". Fastly and Varnish list one entry per node; the last is the edge that answered.
    if (/\bFROM CLOUDFRONT\b/.test(xCache)) return /^(REFRESH)?HIT\b/.test(xCache) ? "cloudfront" : null;
    const last = xCache.split(",").pop()!.trim();
    if (!last.startsWith("HIT")) return null;
    return headers.get("x-served-by") ? "fastly" : "cache";
  }
  const proxy = word(headers, "x-cache-status");
  if (proxy) return ["HIT", "STALE", "UPDATING", "REVALIDATED"].includes(proxy) ? "proxy" : null;
  const age = Number(headers.get("age"));
  return Number.isFinite(age) && age > 0 ? "cache" : null;
}
