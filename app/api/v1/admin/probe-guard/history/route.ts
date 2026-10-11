import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { guardHistory } from "@/lib/probe-guard/history";
import { parseGuardRange } from "@/lib/probe-guard/range";

/** GET — counts, bans, probed categories and top sources for `?range=`, across every app. */
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const history = await guardHistory({ range: parseGuardRange(request.nextUrl.searchParams.get("range")) });
    const ids = [...new Set([...history.bans.map((b) => b.appId), ...history.byApp.map((a) => a.appId)].filter((id): id is string => !!id))];
    const names = ids.length ? await db.select({ id: apps.id, displayName: apps.displayName }).from(apps).where(inArray(apps.id, ids)) : [];
    return NextResponse.json({ ...history, appNames: Object.fromEntries(names.map((n) => [n.id, n.displayName])) });
  } catch (error) {
    return handleRouteError(error, "Error reading probe guard history");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/probe-guard/history" });
