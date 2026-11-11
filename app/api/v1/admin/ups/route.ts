import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { upsServers } from "@/lib/db/schema";
import { upsConnectionSchema, upsNameSchema } from "@/lib/ups/probe";
import { encryptPassword, getUpsServer, listUpsServers, toView } from "@/lib/ups/store";
import { recordPoll } from "@/lib/ups/monitor";
import { logger } from "@/lib/logger";

const log = logger.child("ups");

const createSchema = upsConnectionSchema.extend({
  name: z.string().trim().max(80).optional(),
  upsName: upsNameSchema,
  enabled: z.boolean().default(true),
});

/** GET /api/v1/admin/ups — UPS servers with their latest state */
async function handleGet() {
  try {
    await requireAppAdmin();
    const rows = await listUpsServers();
    return NextResponse.json({ servers: rows.map(toView) });
  } catch (error) {
    return handleRouteError(error, "Error listing UPS servers");
  }
}

/** POST /api/v1/admin/ups — add a UPS server and poll it once */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    const d = parsed.data;

    let row;
    try {
      [row] = await db
        .insert(upsServers)
        .values({
          id: nanoid(),
          name: d.name || d.upsName,
          host: d.host,
          port: d.port,
          upsName: d.upsName,
          username: d.username || null,
          password: encryptPassword(d.password),
          tls: d.tls,
          enabled: d.enabled,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) return NextResponse.json({ error: "That UPS is already being watched." }, { status: 409 });
      throw err;
    }

    if (row.enabled) await recordPoll(row).catch((err) => log.warn(`First poll of ${row.name} failed:`, err));
    const fresh = await getUpsServer(row.id);
    return NextResponse.json({ server: toView(fresh ?? row) }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error adding UPS server");
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/admin/ups" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-ups" });
