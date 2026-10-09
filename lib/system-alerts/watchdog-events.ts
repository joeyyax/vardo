// Restarts the out-of-process watchdog (scripts/watchdog.sh) records in its events.log.

import { join } from "path";
import { VARDO_HOME_DIR } from "@/lib/paths";

export const WATCHDOG_EVENTS_FILE = join(VARDO_HOME_DIR, "watchdog", "events.log");

/** systemSettings key holding the newest event already surfaced, in epoch seconds. */
export const WATCHDOG_CURSOR_KEY = "watchdog_events_seen";

/** How far back the first read looks. */
export const FIRST_READ_LOOKBACK_S = 24 * 60 * 60;

export type WatchdogEvent = {
  ts: number;
  role: string;
  container: string;
  action: "restart" | "restart-failed" | "backoff";
  fails: number;
};

const ACTIONS = new Set(["restart", "restart-failed", "backoff"]);

/** Events newer than `since` (epoch seconds), oldest first. Malformed lines are skipped. */
export function newWatchdogEvents(text: string, since: number): WatchdogEvent[] {
  const events: WatchdogEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<WatchdogEvent>;
      if (typeof e.ts !== "number" || e.ts <= since) continue;
      if (typeof e.container !== "string" || typeof e.action !== "string" || !ACTIONS.has(e.action)) continue;
      events.push({
        ts: e.ts,
        role: typeof e.role === "string" ? e.role : e.container,
        container: e.container,
        action: e.action as WatchdogEvent["action"],
        fails: typeof e.fails === "number" ? e.fails : 0,
      });
    } catch {
      // Partial write.
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

/** Title and message for the alert. */
export function describeWatchdogEvent(e: WatchdogEvent): { title: string; message: string } {
  const at = new Date(e.ts * 1000).toISOString();
  switch (e.action) {
    case "restart":
      return {
        title: `Watchdog restarted ${e.container}`,
        message: `${e.container} was unhealthy for ${e.fails} checks in a row, so the watchdog restarted it at ${at}.`,
      };
    case "restart-failed":
      return {
        title: `Watchdog couldn't restart ${e.container}`,
        message: `${e.container} was unhealthy for ${e.fails} checks in a row and the watchdog's restart failed at ${at}.`,
      };
    case "backoff":
      return {
        title: `Watchdog stopped restarting ${e.container}`,
        message: `${e.container} is still unhealthy after repeated restarts, so the watchdog is leaving it alone for now (${at}).`,
      };
  }
}
