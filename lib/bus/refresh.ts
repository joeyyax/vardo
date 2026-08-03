// ---------------------------------------------------------------------------
// Bus event → data refresh
//
// Server-rendered surfaces stay live by refreshing on the events that change
// them, whatever started the work: the UI, the REST API, the MCP server or a
// git webhook.
// ---------------------------------------------------------------------------

import type { BusEvent, BusEventType } from "./events";

/** Event prefixes whose payload changes something a server component renders. */
const REFRESH_PREFIXES = ["deploy.", "app.", "backup."] as const;

/** Whether this event should trigger a router.refresh(). */
export function isRefreshEvent(type: string): type is BusEventType {
  return REFRESH_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** Quiet period after the last event before the refresh fires. */
export const REFRESH_DEBOUNCE_MS = 400;

/** Cap on how long a continuous burst of events can defer the refresh. */
export const REFRESH_MAX_WAIT_MS = 2000;

export type RefreshScheduler = {
  schedule: () => void;
  cancel: () => void;
};

/**
 * Debounces refreshes so a burst of events costs one render, while the max
 * wait keeps a long burst from deferring it indefinitely.
 */
export function createRefreshScheduler(
  run: () => void,
  opts?: { delayMs?: number; maxWaitMs?: number },
): RefreshScheduler {
  const delayMs = opts?.delayMs ?? REFRESH_DEBOUNCE_MS;
  const maxWaitMs = opts?.maxWaitMs ?? REFRESH_MAX_WAIT_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstQueuedAt = 0;

  function fire() {
    timer = null;
    firstQueuedAt = 0;
    run();
  }

  return {
    schedule() {
      const now = Date.now();
      if (timer === null) {
        firstQueuedAt = now;
        timer = setTimeout(fire, delayMs);
        return;
      }
      clearTimeout(timer);
      const remaining = Math.min(delayMs, firstQueuedAt + maxWaitMs - now);
      timer = setTimeout(fire, Math.max(0, remaining));
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      firstQueuedAt = 0;
    },
  };
}

/**
 * App status implied by a finished deploy, or null while it is still running.
 * Drives the optimistic status a deploying app shows until the server data
 * catches up.
 */
export function appStatusFromEvent(event: BusEvent): string | null {
  switch (event.type) {
    case "deploy.success":
      return "active";
    case "deploy.failed":
      return "error";
    // Unfinished tail work, but the release cut over and is serving.
    case "deploy.incomplete":
      return "active";
    case "deploy.status":
      if (event.status === "running") return null;
      if (event.status === "active") return "active";
      if (event.status === "error") return "error";
      return "stopped";
    default:
      return null;
  }
}
