// ---------------------------------------------------------------------------
// Alert state tracking — prevents notification spam
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child("system-alerts");

export type AlertType =
  | "service-degraded"
  | "disk-space"
  | "host-restarted"
  | "cert-expiring"
  | "update-available";

type AlertState = {
  lastFired: Date;
  count: number;
};

// Rate limit windows in milliseconds per alert type
const RATE_LIMITS: Record<AlertType, number> = {
  "service-degraded": 15 * 60 * 1000, // 15 min
  "disk-space": 60 * 60 * 1000, // 1 hour
  "host-restarted": 365 * 24 * 60 * 60 * 1000, // effectively once per startup (reset on process restart)
  "cert-expiring": 24 * 60 * 60 * 1000, // 1 day
  "update-available": 24 * 60 * 60 * 1000, // 24 hours
};

// In-memory hot path — source of truth during runtime
const state = new Map<string, AlertState>();

// Track whether we've loaded from DB yet
let loadedFromDb = false;

function makeKey(type: AlertType, key: string): string {
  return `${type}:${key}`;
}

// ---------------------------------------------------------------------------
// DB persistence helpers
// ---------------------------------------------------------------------------

const DB_KEY = "system_alert_state";

type PersistedEntry = {
  lastFired: string; // ISO string
  count: number;
};

type PersistedState = Record<string, PersistedEntry>;

async function persistToDb(): Promise<void> {
  try {
    const snapshot: PersistedState = {};
    for (const [k, v] of state.entries()) {
      snapshot[k] = { lastFired: v.lastFired.toISOString(), count: v.count };
    }
    await db
      .insert(systemSettings)
      .values({ key: DB_KEY, value: JSON.stringify(snapshot) })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: JSON.stringify(snapshot), updatedAt: new Date() },
      });
  } catch (err) {
    // Best-effort — never let a DB write block alert logic
    log.error("Failed to persist alert state:", err);
  }
}

/**
 * Load alert state from the database into the in-memory map.
 * Called once at startup before the first tick.
 */
export async function loadAlertState(): Promise<void> {
  if (loadedFromDb) return;
  loadedFromDb = true;
  try {
    const row = await db.query.systemSettings.findFirst({
      where: (t, { eq }) => eq(t.key, DB_KEY),
    });
    if (!row) return;
    const parsed = JSON.parse(row.value) as PersistedState;
    for (const [k, v] of Object.entries(parsed)) {
      state.set(k, { lastFired: new Date(v.lastFired), count: v.count });
    }
    log.info(`Loaded ${state.size} alert state entries from DB`);
  } catch (err) {
    log.error("Failed to load alert state from DB:", err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function shouldFire(type: AlertType, key: string): boolean {
  const mapKey = makeKey(type, key);
  const entry = state.get(mapKey);
  if (!entry) return true;
  const elapsed = Date.now() - entry.lastFired.getTime();
  return elapsed >= RATE_LIMITS[type];
}

export function markFired(type: AlertType, key: string): void {
  const mapKey = makeKey(type, key);
  const existing = state.get(mapKey);
  state.set(mapKey, {
    lastFired: new Date(),
    count: (existing?.count ?? 0) + 1,
  });
  // Fire-and-forget — don't block the caller on DB I/O
  persistToDb().catch(() => {});
}

export function getAlertState(): Array<{
  type: AlertType;
  key: string;
  lastFired: Date;
  count: number;
}> {
  return Array.from(state.entries()).map(([mapKey, entry]) => {
    const colonIdx = mapKey.indexOf(":");
    return {
      type: mapKey.slice(0, colonIdx) as AlertType,
      key: mapKey.slice(colonIdx + 1),
      lastFired: entry.lastFired,
      count: entry.count,
    };
  });
}

export function clearAlertState(type?: AlertType, key?: string): void {
  if (type !== undefined && key !== undefined) {
    state.delete(makeKey(type, key));
  } else {
    state.clear();
  }
  // Sync the deletion to DB
  persistToDb().catch(() => {});
}
