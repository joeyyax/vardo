import { COMPOSE_DOWN_TIMEOUT } from "./constants";
import type { ComposeService } from "./compose-types";

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001, ns: 0.000001 };

/** Milliseconds in a compose duration like `135s`, `2m` or `1m30s`; null when unparseable. */
export function parseComposeDuration(value: string | undefined): number | null {
  if (!value) return null;
  const parts = [...value.trim().matchAll(/(\d+(?:\.\d+)?)(h|ms|us|ns|m|s)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== value.trim()) return null;
  return parts.reduce((ms, [, n, unit]) => ms + Number(n) * UNIT_MS[unit], 0);
}

/** Time to allow `docker compose stop`: the longest grace period plus 15s, never under the default. */
export function composeStopTimeout(services: Record<string, ComposeService>): number {
  const longest = Math.max(0, ...Object.values(services).map((s) => parseComposeDuration(s.stop_grace_period) ?? 0));
  return Math.max(COMPOSE_DOWN_TIMEOUT, longest + 15_000);
}
