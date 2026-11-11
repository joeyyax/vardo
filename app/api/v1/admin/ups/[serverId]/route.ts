import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { upsServers } from "@/lib/db/schema";
import { noBreaks, upsGraceSchema, upsHostSchema, upsNameSchema, upsPortSchema } from "@/lib/ups/probe";
import { encryptPassword, getUpsServer, toView } from "@/lib/ups/store";
import { closeUpsIncidents, recordPoll } from "@/lib/ups/monitor";
import { deleteUpsHistory } from "@/lib/ups/history";

type Params = { params: Promise<{ serverId: string }> };

/** Omitted fields stay as they are; a null or empty password clears it. */
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  host: upsHostSchema.optional(),
  port: upsPortSchema.optional(),
  upsName: upsNameSchema.optional(),
  username: noBreaks("Username").nullable().optional(),
  password: noBreaks("Password").nullable().optional(),
  tls: z.boolean().optional(),
  enabled: z.boolean().optional(),
  onBatteryGraceSec: upsGraceSchema.optional(),
});

/** GET /api/v1/admin/ups/[serverId] */
async function handleGet(_request: NextRequest, { params }: Params) {
  try {
    await requireAppAdmin();
    const row = await getUpsServer((await params).serverId);
    if (!row) return apiError.notFound("UPS server");
    return NextResponse.json({ server: toView(row) });
  } catch (error) {
    return handleRouteError(error, "Error reading UPS server");
  }
}

/** PATCH /api/v1/admin/ups/[serverId] — edit; a new target starts its state over */
async function handlePatch(request: NextRequest, { params }: Params) {
  try {
    await requireAppAdmin();
    const existing = await getUpsServer((await params).serverId);
    if (!existing) return apiError.notFound("UPS server");

    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    const { password, username, ...rest } = parsed.data;

    const retarget =
      (rest.host !== undefined && rest.host !== existing.host) ||
      (rest.port !== undefined && rest.port !== existing.port) ||
      (rest.upsName !== undefined && rest.upsName !== existing.upsName);
    const stopping = rest.enabled === false && existing.enabled;

    let row;
    try {
      [row] = await db
        .update(upsServers)
        .set({
          ...rest,
          ...(username !== undefined ? { username: username || null } : {}),
          ...(password !== undefined ? { password: encryptPassword(password) } : {}),
          ...(retarget || stopping ? { state: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(upsServers.id, existing.id))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) return NextResponse.json({ error: "That UPS is already being watched." }, { status: 409 });
      throw err;
    }

    if (retarget || stopping) await closeUpsIncidents(existing.id);
    if (retarget) await deleteUpsHistory(existing.id);
    if (row.enabled && (retarget || !existing.enabled || password !== undefined || rest.tls !== undefined)) {
      await recordPoll(row).catch(() => {});
      row = (await getUpsServer(row.id)) ?? row;
    }
    return NextResponse.json({ server: toView(row) });
  } catch (error) {
    return handleRouteError(error, "Error updating UPS server");
  }
}

/** DELETE /api/v1/admin/ups/[serverId] */
async function handleDelete(_request: NextRequest, { params }: Params) {
  try {
    await requireAppAdmin();
    const existing = await getUpsServer((await params).serverId);
    if (!existing) return apiError.notFound("UPS server");
    await db.delete(upsServers).where(eq(upsServers.id, existing.id));
    await closeUpsIncidents(existing.id);
    await deleteUpsHistory(existing.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error removing UPS server");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/ups/*" });
export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-ups" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-ups" });
