const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

type HeaderSource = { get(name: string): string | null };

/** Host of an origin or URL, lowercased. Null when unparseable. */
function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Hosts this instance answers on, as the request and the config describe it. */
function ownHosts(headers: HeaderSource, env: NodeJS.ProcessEnv): Set<string> {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    const trimmed = h?.split(",")[0]?.trim().toLowerCase();
    if (trimmed) hosts.add(trimmed);
  };
  add(headers.get("host"));
  add(headers.get("x-forwarded-host"));
  add(hostOf(env.NEXT_PUBLIC_APP_URL));
  add(hostOf(env.NEXT_PUBLIC_BETTER_AUTH_URL));
  for (const origin of (env.VARDO_TRUSTED_ORIGINS ?? "").split(",")) {
    add(hostOf(origin.trim()));
  }
  return hosts;
}

/**
 * Why a request riding a session cookie looks cross-site, or null to let it
 * through. Bearer requests and requests without a session cookie carry no
 * ambient credential and are never blocked. Better Auth checks its own routes.
 */
export function csrfRejection(
  req: { method: string; pathname: string; headers: HeaderSource },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.VARDO_CSRF_CHECK === "off") return null;
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (req.pathname.startsWith("/api/auth/")) return null;
  if (req.headers.get("authorization")?.startsWith("Bearer ")) return null;
  if (!SESSION_COOKIE.test(req.headers.get("cookie") ?? "")) return null;

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "none") return null;

  const origin = req.headers.get("origin");
  if (!origin) {
    // Browsers send one of the two on every cross-site POST.
    return fetchSite ? `cross-site request (${fetchSite})` : null;
  }

  const originHost = hostOf(origin);
  if (originHost && ownHosts(req.headers, env).has(originHost)) return null;
  return `origin ${origin} is not this instance`;
}
