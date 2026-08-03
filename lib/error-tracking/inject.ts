// ---------------------------------------------------------------------------
// Deploy-time DSN injection — hands each container a GLITCHTIP_DSN pointing at
// the GlitchTip project named after the app row that owns it.
//
// Every failure path here degrades to "no DSN injected". GlitchTip is optional
// infrastructure and must never fail a deploy.
// ---------------------------------------------------------------------------

import { isFeatureEnabledAsync } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("error-tracking");

/** Env var the injected DSN is written to. */
export const DSN_ENV_KEY = "GLITCHTIP_DSN";

/** An operator value under any of these keys means hands off. */
const OPERATOR_DSN_KEYS = ["GLITCHTIP_DSN", "SENTRY_DSN"];

/** Ceiling on the whole resolution, whatever GlitchTip is doing. */
const RESOLVE_TIMEOUT_MS = 8_000;

/** How long a resolved DSN is reused. Project creation is find-or-create, but costs 3-5 API calls. */
const CACHE_TTL_MS = 60 * 60 * 1000;

const dsnCache = new Map<string, { dsn: string; expiresAt: number }>();

/** Drop cached DSNs. For tests. */
export function clearDSNCache(): void {
  dsnCache.clear();
}

/** True when any env map carries an operator-set DSN. */
export function hasOperatorDSN(...envs: (Record<string, string> | undefined)[]): boolean {
  return envs.some((env) => env && OPERATOR_DSN_KEYS.some((key) => key in env));
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`GlitchTip timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * DSNs for the given app names, cached per process. Returns only what resolved —
 * a disabled feature flag, an unreachable GlitchTip or an API error yields an
 * empty map rather than an error.
 */
async function resolveProjectDSNs(appNames: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const wanted = [...new Set(appNames.filter(Boolean))];
  if (wanted.length === 0) return resolved;

  if (!(await isFeatureEnabledAsync("error-tracking"))) return resolved;

  const now = Date.now();
  const misses: string[] = [];
  for (const name of wanted) {
    const cached = dsnCache.get(name);
    if (cached && now < cached.expiresAt) resolved.set(name, cached.dsn);
    else misses.push(name);
  }
  if (misses.length === 0) return resolved;

  const { isGlitchTipAvailable, ensureProjectDSN } = await import("./client");
  if (!(await isGlitchTipAvailable())) return resolved;

  await withTimeout(
    Promise.all(
      misses.map(async (name) => {
        const dsn = await ensureProjectDSN(name);
        if (!dsn) return;
        dsnCache.set(name, { dsn, expiresAt: Date.now() + CACHE_TTL_MS });
        resolved.set(name, dsn);
      }),
    ),
    RESOLVE_TIMEOUT_MS,
  );

  return resolved;
}

/**
 * Per-service DSN to merge into the deploy overlay, keyed by compose service.
 * A service whose app or compose file already sets a DSN is left alone, and any
 * GlitchTip problem returns an empty result.
 */
export async function resolveServiceDSNs(opts: {
  /** Parent app name — the project for services with no child app row. */
  appName: string;
  /** Compose services being deployed. */
  services: Record<string, { environment?: Record<string, string> }>;
  /** Decomposed child app name per compose service. */
  serviceAppNames?: Record<string, string>;
  /** Parent app's own env vars. */
  appEnv?: Record<string, string>;
  /** Child app env vars per compose service, before template resolution. */
  serviceEnv?: Record<string, Record<string, string>>;
}): Promise<Record<string, string>> {
  const { appName, services, serviceAppNames = {}, appEnv = {}, serviceEnv = {} } = opts;

  try {
    const owners = new Map<string, string>();
    for (const [service, svc] of Object.entries(services)) {
      if (hasOperatorDSN(appEnv, serviceEnv[service], svc.environment)) continue;
      owners.set(service, serviceAppNames[service] ?? appName);
    }
    if (owners.size === 0) return {};

    const dsns = await resolveProjectDSNs([...owners.values()]);
    const result: Record<string, string> = {};
    for (const [service, owner] of owners) {
      const dsn = dsns.get(owner);
      if (dsn) result[service] = dsn;
    }
    return result;
  } catch (err) {
    log.warn("Skipping DSN injection:", err instanceof Error ? err.message : err);
    return {};
  }
}
