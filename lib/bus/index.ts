/** Event bus: writes typed BusEvents to Redis Streams and runs local emit hooks. */

import { nanoid } from "nanoid";
import { addEvent } from "@/lib/stream/producer";
import type { BusEvent } from "./events";
import { logger } from "@/lib/logger";

const log = logger.child("bus");

export type { BusEvent, BusEventType } from "./events";
export { EVENT_CATEGORIES, ALL_EVENT_TYPES } from "./events";

type EmitHook = (orgId: string, event: BusEvent) => void;
const emitHooks = new Map<string, EmitHook>();

/** Registers a named hook that runs on every emit(). Keyed by name so HMR doesn't duplicate it. */
export function onEmit(name: string, hook: EmitHook): void {
  emitHooks.set(name, hook);
}

/**
 * Emits a typed event to an org's stream and runs emit hooks. Never throws.
 * Import emit from @/lib/notifications/dispatch, or channels won't fire.
 */
export function emit(orgId: string, input: BusEvent): void {
  const event: BusEvent = input.id ? input : { ...input, id: `evt_${nanoid(20)}` };
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
