import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireSession, isScopedToken } from "@/lib/auth/session";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { UI_DENSITIES } from "@/lib/db/schema";
import { getUserPreferences, setUserPreferences } from "@/lib/user/preferences";

const putSchema = z.object({ density: z.enum(UI_DENSITIES).optional() }).strict();

/** GET — the signed-in user's interface preferences. */
async function handleGet() {
  try {
    const session = await requireSession();
    if (isScopedToken(session)) return apiError.forbidden();
    return NextResponse.json(await getUserPreferences(session.user.id));
  } catch (error) {
    return handleRouteError(error, "Error fetching preferences");
  }
}

/** PUT — merges the given preferences. */
async function handlePut(req: NextRequest) {
  try {
    const session = await requireSession();
    if (isScopedToken(session)) return apiError.forbidden();

    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);

    await setUserPreferences(session.user.id, parsed.data);
    return NextResponse.json(await getUserPreferences(session.user.id));
  } catch (error) {
    return handleRouteError(error, "Error saving preferences");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/user/preferences" });
export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "user-preferences" });
