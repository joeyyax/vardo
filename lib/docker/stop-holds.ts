// ---------------------------------------------------------------------------
// Containers Vardo stopped on purpose and will start again itself.
//
// Held containers are off limits to self-heal until released.
// ---------------------------------------------------------------------------

const holds = new Map<string, string>();

/** Mark a container as deliberately stopped, with who stopped it. */
export function holdStopped(containerId: string, holder: string): void {
  holds.set(containerId, holder);
}

export function releaseStopped(containerId: string): void {
  holds.delete(containerId);
}

/** Holder of a stopped container, matched on either the full or the short id. */
export function stopHolder(containerId: string): string | null {
  for (const [id, holder] of holds) {
    if (id === containerId || id.startsWith(containerId) || containerId.startsWith(id)) return holder;
  }
  return null;
}
