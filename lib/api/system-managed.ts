// Refuses verbs that rewrite Vardo's own app and project rows, which boot regenerates.

import { NextResponse } from "next/server";

import { isVardoStack, VARDO_SELF_APP_NAME } from "@/lib/self-app-name";

export { isVardoStack, VARDO_SELF_APP_NAME };

export type SystemManagedAction =
  | "deploy"
  | "rollback"
  | "restart"
  | "recreate"
  | "stop"
  | "edit"
  | "delete"
  | "env-vars"
  | "domains"
  | "image-update";

type Guarded = { isSystemManaged: boolean | null; name?: string | null };

/** Core service image tags come from files Vardo ships. */
export const IMAGE_UPDATE_REFUSAL =
  "Vardo pins this image in docker-compose.yml or a service template and rewrites it on every restart. It moves with the next Vardo release.";

// Verbs that rewrite the record. Vardo owns those fields.
const DEFINITION_REFUSALS: Partial<Record<SystemManagedAction, string>> = {
  edit: "Vardo manages this and rewrites the record every time it restarts, so the change wouldn't survive. Edit docker-compose.yml or the service template instead.",
  delete: "Vardo manages this and recreates it on the next restart. Remove it from docker-compose.yml, or turn off the feature that provisions it.",
  "env-vars":
    "Env vars for Vardo-managed apps come from docker-compose.yml and the host environment, and are rewritten on every restart.",
  domains:
    "Domains for Vardo-managed apps come from docker-compose.yml and are rewritten on every restart.",
  "image-update": IMAGE_UPDATE_REFUSAL,
};

/** Stopping Vardo's own stack takes down the API you would call to start it again. */
export const VARDO_STOP_REFUSAL =
  "Stopping Vardo would take down the API you need to start it again. Run `docker compose stop` on the host instead.";

/** Why a system-managed app or project refuses `action`, or null when allowed. */
export function systemManagedRefusal(
  target: Guarded,
  action: SystemManagedAction,
): string | null {
  // Check before the flag; a child's false is_system_managed would unlock the stop.
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
