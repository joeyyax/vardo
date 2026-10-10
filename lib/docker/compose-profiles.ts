// Compose profiles, selected by the app's COMPOSE_PROFILES.

import type { ComposeFile, ComposeService } from "./compose-types";
import { excludeServices } from "./compose-inject";

/** Active profiles from a COMPOSE_PROFILES value. Null when unset. */
export function parseComposeProfiles(value: string | null | undefined): Set<string> | null {
  if (value == null) return null;
  return new Set(value.split(",").map((p) => p.trim()).filter(Boolean));
}

/**
 * Drop services whose profiles are all inactive, and the `profiles` key from the rest.
 * With no COMPOSE_PROFILES every service deploys.
 */
export function applyComposeProfiles(
  compose: ComposeFile,
  active: Set<string> | null,
): { compose: ComposeFile; skipped: string[] } {
  const skipped = active
    ? Object.entries(compose.services)
        .filter(([, svc]) => svc.profiles?.length && !active.has("*") && !svc.profiles.some((p) => active.has(p)))
        .map(([name]) => name)
    : [];
  if (skipped.length > 0 && skipped.length === Object.keys(compose.services).length) {
    throw new Error(
      `Every service is behind a profile COMPOSE_PROFILES doesn't list (${[...active!].join(",") || "empty"}) — nothing to deploy`,
    );
  }

  const kept = skipped.length > 0 ? excludeServices(compose, skipped) : compose;
  const services: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(kept.services)) {
    const { profiles: _, ...rest } = svc;
    services[name] = rest;
  }
  return { compose: { ...kept, services }, skipped };
}
