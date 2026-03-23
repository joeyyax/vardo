/**
 * Event bus — thin wrapper over the existing Redis pub/sub in lib/events.
 *
 * Publishes typed BusEvents to org-scoped Redis channels and provides
 * a subscribe/unsubscribe API for listeners. Events are tagged with
 * `source: "bus"` so non-bus messages on the same channel are ignored.
 *
 * Emit hooks allow modules (like notification dispatch) to register
 * synchronous side effects that run on every emit() call without
 * requiring a Redis roundtrip.
 */

import { publishEvent, subscribe, orgChannel } from "@/lib/events";
import type { BusEvent } from "./events";

export type { BusEvent, BusEventType } from "./events";
export { EVENT_CATEGORIES, ALL_EVENT_TYPES } from "./events";
export { toBusEvent, toLegacyEvent } from "./compat";

// ---------------------------------------------------------------------------
// Emit hooks — synchronous side effects on emit()
// ---------------------------------------------------------------------------

type EmitHook = (orgId: string, event: BusEvent) => void;
const emitHooks: EmitHook[] = [];

/**
 * Register a hook that runs on every emit() call. Used by the notification
 * dispatch module to trigger channel delivery without a Redis roundtrip.
 *
 * Hooks run synchronously and should not throw. Async work should be
 * wrapped in Promise.resolve().then(...) internally.
 */
export function onEmit(hook: EmitHook): void {
  emitHooks.push(hook);
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Emit a typed event to an org's bus channel.
 *
 * 1. Publishes to Redis for remote consumers (SSE endpoints, future workers)
 * 2. Runs registered emit hooks for local consumers (notification dispatch)
 *
 * Fire-and-forget: errors are logged but never thrown to the caller.
 *
 * IMPORTANT: To ensure notification channels (email, webhook, slack) fire,
 * import `emit` from `@/lib/notifications/dispatch` rather than directly
 * from this module. That import triggers the dispatch hook registration
 * as a side effect.
 */
export function emit(orgId: string, event: BusEvent): void {
  // Publish to Redis
  publishEvent(orgChannel(orgId), {
    source: "bus",
    ...event,
    timestamp: Date.now(),
  }).catch((err) => {
    console.error("[bus] emit failed:", err);
  });

  // Run local hooks
  for (const hook of emitHooks) {
    try {
      hook(orgId, event);
    } catch (err) {
      console.error("[bus] emit hook error:", err);
    }
  }
}

type BusCallback = (event: BusEvent) => void;

/**
 * Subscribe to bus events for an org via Redis. Returns an unsubscribe function.
 *
 * Only events with `source: "bus"` are forwarded — other messages on
 * the org channel (app state changes, etc.) are silently ignored.
 */
export function on(orgId: string, cb: BusCallback): () => void {
  return subscribe(orgChannel(orgId), (data) => {
    if (data.source !== "bus") return;
    cb(data as unknown as BusEvent);
  });
}
