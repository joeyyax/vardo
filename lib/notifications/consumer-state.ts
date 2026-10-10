// Orgs the notification stream consumer reads: this process's set, plus a Redis set any process's consumer keeps alive.

import { redis } from "@/lib/redis";

/** Orgs some process's consumer reads. Expires unless a running consumer refreshes it. */
export const SHARED_KEY = "notifications:consumed-orgs";
const SHARED_TTL_MS = 60_000;
const REFRESH_MS = 20_000;

type State = { orgs: Set<string>; timer: NodeJS.Timeout | null };

const KEY = Symbol.for("vardo.notifications.consumedOrgs");

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { orgs: new Set(), timer: null });
}

async function publishShared(): Promise<void> {
  const orgs = [...state().orgs];
  if (orgs.length === 0) return;
  await redis.multi().sadd(SHARED_KEY, ...orgs).pexpire(SHARED_KEY, SHARED_TTL_MS).exec();
}

export function markConsumedOrgs(orgIds: string[]): void {
  const s = state();
  for (const id of orgIds) s.orgs.add(id);
  void publishShared().catch(() => {});
  if (!s.timer) {
    s.timer = setInterval(() => void publishShared().catch(() => {}), REFRESH_MS);
    s.timer.unref?.();
  }
}

/** Stops this process's claim. The shared set lapses on its own once no consumer refreshes it. */
export function clearConsumedOrgs(): void {
  const s = state();
  s.orgs.clear();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/** Whether this process's stream consumer delivers this org's events. */
export function isConsumedOrg(orgId: string): boolean {
  return state().orgs.has(orgId);
}

/** Whether any process's stream consumer delivers this org's events. False when Redis can't say. */
export async function isConsumedAnywhere(orgId: string): Promise<boolean> {
  if (isConsumedOrg(orgId)) return true;
  try {
    return (await redis.sismember(SHARED_KEY, orgId)) === 1;
  } catch {
    return false;
  }
}
