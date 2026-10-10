import { NextResponse } from "next/server";
import { isAppAdmin } from "@/lib/auth/admin";
import { SYSTEM_EXEC_REQUIRES_ADMIN } from "@/lib/auth/system-org";

type Flagged = { isSystemManaged?: boolean | null } | null | undefined;

/** True when terminal or cron here runs with Vardo's own host access. */
export function isSystemExecTarget(org: Flagged, app: Flagged): boolean {
  return Boolean(org?.isSystemManaged || app?.isSystemManaged);
}

/** 403 unless a session-signed-in instance admin is the caller, for the system org or a system-managed app. Null to continue. */
export async function refuseSystemExec(org: Flagged, app: Flagged): Promise<NextResponse | null> {
  if (!isSystemExecTarget(org, app)) return null;
  if (await isAppAdmin()) return null;
  return NextResponse.json({ error: SYSTEM_EXEC_REQUIRES_ADMIN }, { status: 403 });
}
