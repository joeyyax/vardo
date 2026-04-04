/**
 * Event bus — writes typed BusEvents to Redis Streams and runs local
 * emit hooks (notification dispatch fallback).
 *
 * All consumers have been migrated to Redis Streams. The old pub/sub
 * system (lib/events.ts) is no longer used by this module.
 */

import { addEvent } from "@/lib/stream/producer";
import type { BusEvent } from "./events";
import { logger } from "@/lib/logger";

const log = logger.child("bus");

export type { BusEvent, BusEventType } from "./events";
export { EVENT_CATEGORIES, ALL_EVENT_TYPES } from "./events";

// ---------------------------------------------------------------------------
// Emit hooks — synchronous side effects on emit()
// ---------------------------------------------------------------------------

type EmitHook = (orgId: string, event: BusEvent) => void;
const emitHooks = new Map<string, EmitHook>();

/**
 * Register a named hook that runs on every emit() call.
 * Used as a fallback by notification dispatch when the stream consumer
 * fails to start.
 *
 * Keyed by name to prevent duplicate registrations during HMR.
 */
export function onEmit(name: string, hook: EmitHook): void {
  emitHooks.set(name, hook);
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Emit a typed event to an org's event stream.
 *
 * 1. Writes to Redis Stream (persistent, replayable)
 * 2. Runs registered emit hooks (fallback notification dispatch)
 *
 * Fire-and-forget: errors are logged but never thrown to the caller.
 *
 * IMPORTANT: To ensure notification channels (email, webhook, slack) fire,
 * import `emit` from `@/lib/notifications/dispatch` rather than directly
 * from this module. That import triggers the stream consumer startup
 * as a side effect.
 */
export function emit(orgId: string, event: BusEvent): void {
  addEvent(orgId, event).catch((err) => {
    log.error("stream emit failed:", err);
  });

  for (const hook of emitHooks.values()) {
    try {
      hook(orgId, event);
    } catch (err) {
      log.error("emit hook error:", err);
    }
  }
}
