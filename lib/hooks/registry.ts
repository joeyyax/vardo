// ---------------------------------------------------------------------------
// Hook registry — query and manage registered hooks
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { hookRegistrations } from "@/lib/db/schema";
import { eq, and, or, isNull, asc } from "drizzle-orm";
import type { HookContext } from "./types";

/**
 * Get all enabled hooks for an event, ordered by priority (lower first).
 *
 * Resolution order (most specific wins for same priority):
 *   app-level > org-level > system-level
 *
 * All matching hooks run in priority order. App/org scoping is additive —
 * system hooks always run, org hooks add to them, app hooks add to those.
 */
export async function getHooksForEvent(
  event: string,
  opts?: { organizationId?: string; appId?: string },
) {
  const conditions = [
    eq(hookRegistrations.event, event),
    eq(hookRegistrations.enabled, true),
  ];

  // Build scope filter: system-level + org-level + app-level
  const scopeConditions = [isNull(hookRegistrations.organizationId)]; // system always
  if (opts?.organizationId) {
    scopeConditions.push(eq(hookRegistrations.organizationId, opts.organizationId));
  }
  if (opts?.appId) {
    scopeConditions.push(eq(hookRegistrations.appId, opts.appId));
  }

  return db.query.hookRegistrations.findMany({
    where: and(...conditions, or(...scopeConditions)),
    orderBy: [asc(hookRegistrations.priority)],
  });
}

/**
 * Internal handler registry — for built-in hooks that call functions directly
 * instead of webhooks or scripts.
 */
type InternalHandler = (context: HookContext) => Promise<{ allowed: boolean; reason?: string }>;
const internalHandlers = new Map<string, InternalHandler>();

/** Register an internal hook handler (used by built-in features). */
export function registerInternalHandler(name: string, handler: InternalHandler): void {
  internalHandlers.set(name, handler);
}

/** Get an internal handler by name. */
export function getInternalHandler(name: string): InternalHandler | undefined {
  return internalHandlers.get(name);
}
