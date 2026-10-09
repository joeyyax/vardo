// Per-domain Traefik middlewares, stored comma-separated in domains.middlewares.

export const CLOUDFLARE_ONLY_MIDDLEWARE = "cloudflare-only@file";

/** Middlewares Vardo defines and maintains. The only ones an untrusted organization may reference. */
export const VARDO_MIDDLEWARES: ReadonlySet<string> = new Set([CLOUDFLARE_ONLY_MIDDLEWARE]);

// A Traefik middleware name with an optional @provider.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}(@[a-z][a-z0-9-]{0,30})?$/;

export function parseMiddlewares(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return [...new Set(stored.split(",").map((m) => m.trim()).filter(Boolean))];
}

export function serializeMiddlewares(list: string[]): string | null {
  const unique = [...new Set(list.map((m) => m.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.join(",") : null;
}

/** Why an organization can't reference a middleware, or null. */
export function middlewareProblem(ref: string, trusted: boolean): string | null {
  if (!REF_RE.test(ref)) return `"${ref.slice(0, 80)}" isn't a middleware name`;
  if (VARDO_MIDDLEWARES.has(ref)) return null;
  if (!trusted) return `"${ref}" isn't a middleware Vardo provides`;
  if (ref.endsWith("@internal")) return `"${ref}" is internal to Traefik`;
  return null;
}

/** Splits a row's middlewares into those the organization may use and those it may not. */
export function partitionMiddlewares(
  stored: string | null | undefined,
  trusted: boolean,
): { allowed: string[]; refused: string[] } {
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const ref of parseMiddlewares(stored)) (middlewareProblem(ref, trusted) ? refused : allowed).push(ref);
  return { allowed, refused };
}
