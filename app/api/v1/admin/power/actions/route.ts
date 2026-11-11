import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { listPowerActions } from "@/lib/power/actions";
import { openStops } from "@/lib/power/stops";

/** GET /api/v1/admin/power/actions — recent policy actions and the apps still stopped for power */
async function handleGet() {
  try {
    await requireAppAdmin();
    const [actions, open] = await Promise.all([listPowerActions(20), openStops()]);
    const names = open.length
      ? await db.query.apps.findMany({ where: inArray(apps.id, open.map((s) => s.appId)), columns: { id: true, displayName: true } })
      : [];
    const nameOf = new Map(names.map((a) => [a.id, a.displayName]));
    return NextResponse.json({
      actions: actions.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        message: a.message,
        notified: a.notifiedAt !== null,
        createdAt: a.createdAt.toISOString(),
      })),
      stopped: open.map((s) => ({ appId: s.appId, name: nameOf.get(s.appId) ?? s.appId, stoppedAt: s.stoppedAt.toISOString() })),
    });
  } catch (error) {
    return handleRouteError(error, "Error listing power actions");
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/admin/power/actions" });
