// Vardo's own app names, without Next imports so the worker can use them.

/** Compose project name for Vardo's own stack. Its children are `vardo-<service>`. */
export const VARDO_SELF_APP_NAME = "vardo";

/** True for Vardo's own compose project and the child apps inside it. */
export function isVardoStack(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === VARDO_SELF_APP_NAME || name.startsWith(`${VARDO_SELF_APP_NAME}-`);
}
