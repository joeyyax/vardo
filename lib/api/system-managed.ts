// ---------------------------------------------------------------------------
// System-managed guard.
//
// Vardo rewrites its own app and project rows on every boot from
// docker-compose.yml and the infra templates, so verbs that change those
// records are refused. Verbs that act on containers are the product path and
// stay open — every one of them has an undo.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

/** Compose project name for Vardo's own stack. Its children are `vardo-<service>`. */
export const VARDO_SELF_APP_NAME = "vardo";

export type SystemManagedAction =
  | "deploy"
  | "rollback"
  | "restart"
  | "recreate"
  | "stop"
  | "edit"
  | "delete"
  | "env-vars"
  | "domains";

type Guarded = { isSystemManaged: boolean | null; name?: string | null };

// Verbs that rewrite the record. Vardo owns those fields.
const DEFINITION_REFUSALS: Partial<Record<SystemManagedAction, string>> = {
  edit: "Vardo manages this and rewrites the record every time it restarts, so the change would not survive. Edit docker-compose.yml or the service template instead.",
  delete: "Vardo manages this and recreates it on the next restart. Remove it from docker-compose.yml, or turn off the feature that provisions it.",
  "env-vars":
    "Env vars for Vardo-managed apps come from docker-compose.yml and the host environment, and are rewritten on every restart.",
  domains:
    "Domains for Vardo-managed apps come from docker-compose.yml and are rewritten on every restart.",
};

/** Stopping Vardo's own stack takes down the API you would call to start it again. */
export const VARDO_STOP_REFUSAL =
  "Stopping Vardo would take down the API you need to start it again. Run `docker compose stop` on the host instead.";

/** True for Vardo's own compose project and the child apps inside it. */
export function isVardoStack(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === VARDO_SELF_APP_NAME || name.startsWith(`${VARDO_SELF_APP_NAME}-`);
}

/**
 * Why a system-managed app or project refuses `action`, or null when it is allowed.
 */
export function systemManagedRefusal(
  target: Guarded,
  action: SystemManagedAction,
): string | null {
  // Checked before the flag: compose children of the Vardo stack carry their
  // own is_system_managed, and a false one there would unlock the stop.
  if (action === "stop" && isVardoStack(target.name)) {
    return VARDO_STOP_REFUSAL;
  }

  if (!target.isSystemManaged) return null;

  return DEFINITION_REFUSALS[action] ?? null;
}

/** 403 response when `action` is refused, or null to let the route continue. */
export function refuseSystemManaged(
  target: Guarded,
  action: SystemManagedAction,
): NextResponse | null {
  const reason = systemManagedRefusal(target, action);
  return reason ? NextResponse.json({ error: reason }, { status: 403 }) : null;
}
