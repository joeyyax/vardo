// Path-prefix routes: a domain row that serves only `/docs` and below.

/** One or more `/segment`s of unreserved URL characters, no trailing slash. */
export const PATH_PREFIX_RE = /^(\/[A-Za-z0-9._~-]+)+$/;

const MAX_LENGTH = 200;

/** `/docs/` → `/docs`; empty or `/` → null. Returns undefined when the input isn't a valid prefix. */
export function normalizePathPrefix(raw: string | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return isPathPrefix(withSlash) ? withSlash : undefined;
}

/** A valid prefix. `.` and `..` segments are refused. */
export function isPathPrefix(value: string): boolean {
  return value.length <= MAX_LENGTH && PATH_PREFIX_RE.test(value) && !value.split("/").some((seg) => /^\.+$/.test(seg));
}

/** Router priority for a path route. Beats the host's root route; a longer prefix beats a shorter one. */
export function pathRoutePriority(pathPrefix: string): number {
  return 1000 + pathPrefix.length;
}

/** `example.com/docs`, or the host alone. */
export function formatRoute(domain: string, pathPrefix: string | null | undefined): string {
  return pathPrefix ? `${domain}${pathPrefix}` : domain;
}
