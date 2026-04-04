import { NextResponse } from "next/server";
import { join } from "path";
import { requireAppAdmin } from "@/lib/auth/admin";
import { writeEnvKey } from "@/lib/env/write-env-key";
import { handleRouteError } from "@/lib/api/error-response";
import { mountsSchema, parseMountPair } from "@/lib/api/admin/maintenance-schemas";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR } from "@/lib/paths";

const log = logger.child("admin:maintenance:mounts");

// GET /api/v1/admin/maintenance/mounts
//
// Returns the current host mount configuration from environment variables.
// Each mount is returned as { source, destination } if set, or null if not configured.
// Handles both new source:destination:ro format and legacy single-path format.

export async function GET() {
  try {
    await requireAppAdmin();

    return NextResponse.json({
      vardoData: parseMountPair(process.env.VARDO_DATA),
      vardoProjects: parseMountPair(process.env.VARDO_PROJECTS),
      vardoMount1: parseMountPair(process.env.VARDO_MOUNT_1),
      vardoMount2: parseMountPair(process.env.VARDO_MOUNT_2),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/maintenance/mounts
//
// Updates host mount configuration by writing to the .env file.
// Requires a Vardo restart to take effect.
// Each mount is sent as { source, destination } and stored as "source:destination".
// For docker-compose compatibility, we append :ro to make it "source:destination:ro".
function formatMountForEnv(value: string | undefined): string {
  if (!value) return "";
  // If already has :ro suffix, return as-is
  if (value.endsWith(":ro")) return value;
  // Append :ro for read-only mount
  return `${value}:ro`;
}

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
      updates.push(["VARDO_DATA", formatMountForEnv(parsed.data.vardoData)]);
    }
    if (parsed.data.vardoProjects !== undefined) {
      updates.push(["VARDO_PROJECTS", formatMountForEnv(parsed.data.vardoProjects)]);
    }
    if (parsed.data.vardoMount1 !== undefined) {
      updates.push(["VARDO_MOUNT_1", formatMountForEnv(parsed.data.vardoMount1)]);
    }
    if (parsed.data.vardoMount2 !== undefined) {
      updates.push(["VARDO_MOUNT_2", formatMountForEnv(parsed.data.vardoMount2)]);
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
