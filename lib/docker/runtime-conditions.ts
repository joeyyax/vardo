import type { AppCondition, ConditionKind } from "./conditions";

/**
 * Conditions that describe a running container. Nothing observes them once the
 * container is gone, so they cannot be true of an app that has none.
 */
const RUNTIME_KINDS = new Set<ConditionKind>([
  "crash-looping",
  "unhealthy",
  "self-heal-exhausted",
  "memory-pressure",
]);

/**
 * Conditions still worth stating for an app with no containers.
 *
 * The health tick only evaluates apps it saw containers for, so a stopped app
 * keeps whatever was last written — an app showing "0/4 services" was also
 * reporting a crash loop from ten hours earlier. Advisory conditions survive:
 * a missing backup or an expiring certificate is no less true while stopped.
 */
export function withoutRuntimeConditions(
  conditions: AppCondition[] | null,
): AppCondition[] {
  if (!conditions) return [];
  return conditions.filter((c) => !RUNTIME_KINDS.has(c.kind));
}

/** Whether stripping would change anything, so an unchanged app skips its write. */
export function hasRuntimeConditions(conditions: AppCondition[] | null): boolean {
  return (conditions ?? []).some((c) => RUNTIME_KINDS.has(c.kind));
}
