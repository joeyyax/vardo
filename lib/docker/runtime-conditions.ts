import type { AppCondition, ConditionKind } from "./conditions";

/** Conditions that only describe a running container. */
const RUNTIME_KINDS = new Set<ConditionKind>([
  "crash-looping",
  "unhealthy",
  "self-heal-exhausted",
  "memory-pressure",
]);

/** Conditions still worth stating for an app with no containers: advisory ones only. */
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
