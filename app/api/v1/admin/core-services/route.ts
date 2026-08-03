import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";

import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import {
  CORE_SERVICE_FLAGS,
  readCoreServiceStatus,
  summarizeCoreServices,
} from "@/lib/infra/core-services";

// GET /api/v1/admin/core-services
export async function GET() {
  try {
    await requireAppAdmin();

    const flagState: Record<string, boolean> = {};
    await Promise.all(
      CORE_SERVICE_FLAGS.map(async (flag) => {
        flagState[flag] = await isFeatureEnabledAsync(flag);
      }),
    );

    const services = summarizeCoreServices(await readCoreServiceStatus(), flagState);

    // Name the org holding each row so an operator can find it.
    const orgIds = [...new Set(services.map((s) => s.organizationId).filter((id): id is string => !!id))];
    const orgs = orgIds.length
      ? await db.query.organizations.findMany({
          where: inArray(organizations.id, orgIds),
          columns: { id: true, name: true, slug: true },
        })
      : [];
    const byId = new Map(orgs.map((o) => [o.id, o]));

    return NextResponse.json({
      services: services.map((service) => ({
        ...service,
        organization: service.organizationId ? (byId.get(service.organizationId) ?? null) : null,
      })),
    });
  } catch (error) {
    return handleRouteError(error, "core-services");
  }
}
