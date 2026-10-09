/** Orgs the notification stream consumer is reading, shared across Next.js module graphs. */

const KEY = Symbol.for("vardo.notifications.consumedOrgs");

function consumedOrgs(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (g[KEY] ??= new Set());
}

export function markConsumedOrgs(orgIds: string[]): void {
  for (const id of orgIds) consumedOrgs().add(id);
}

export function clearConsumedOrgs(): void {
  consumedOrgs().clear();
}

/** Whether the stream consumer delivers this org's events. */
export function isConsumedOrg(orgId: string): boolean {
  return consumedOrgs().has(orgId);
}
