import { NextResponse } from "next/server";
import { join } from "path";
import { requireAppAdmin } from "@/lib/auth/admin";
import { writeEnvKey } from "@/lib/env/write-env-key";
import { handleRouteError } from "@/lib/api/error-response";
import { mountsSchema } from "@/lib/api/admin/maintenance-schemas";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR } from "@/lib/paths";

const log = logger.child("admin:maintenance:mounts");

// GET /api/v1/admin/maintenance/mounts
//
// Returns the current host mount configuration from environment variables.
export async function GET() {
  try {
    await requireAppAdmin();

    return NextResponse.json({
      vardoData: process.env.VARDO_DATA || null,
      vardoProjects: process.env.VARDO_PROJECTS || null,
      vardoMount1: process.env.VARDO_MOUNT_1 || null,
      vardoMount2: process.env.VARDO_MOUNT_2 || null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/maintenance/mounts
//
// Updates host mount configuration by writing to the .env file.
// Requires a Vardo restart to take effect.
export async function POST(request: Request) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = mountsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const envPath = join(VARDO_HOME_DIR, ".env");
    const updates: Array<[string, string]> = [];

    if (parsed.data.vardoData !== undefined) {
      updates.push(["VARDO_DATA", parsed.data.vardoData]);
    }
    if (parsed.data.vardoProjects !== undefined) {
      updates.push(["VARDO_PROJECTS", parsed.data.vardoProjects]);
    }
    if (parsed.data.vardoMount1 !== undefined) {
      updates.push(["VARDO_MOUNT_1", parsed.data.vardoMount1]);
    }
    if (parsed.data.vardoMount2 !== undefined) {
      updates.push(["VARDO_MOUNT_2", parsed.data.vardoMount2]);
    }

    if (updates.length === 0) {
      return NextResponse.json({ ok: true });
    }

    try {
      for (const [key, value] of updates) {
        await writeEnvKey(envPath, key, value);
      }
    } catch (err) {
      log.error(`Failed to write ${envPath}: ${err}`);
      return NextResponse.json(
        { error: "Could not update .env — check server permissions" },
        { status: 500 },
      );
    }

    log.info(`Updated mount config: ${updates.map(([k]) => k).join(", ")}`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
