// Domain redirects: the target URL as a Traefik redirectregex replacement.

/** Target plus the request path. `$` doubled for Go's regexp expansion; trailing slash dropped so the path doesn't double it. */
export function redirectReplacement(redirectTo: string): string {
  return `${redirectTo.replace(/\/+$/, "").replaceAll("$", "$$$$")}\${1}`;
}
