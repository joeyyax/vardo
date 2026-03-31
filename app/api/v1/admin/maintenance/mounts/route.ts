import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { writeEnvKey } from "@/lib/env/write-env-key";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:mounts");

type MountsConfig = {
  mount1: string | null;
  mount2: string | null;
  mount3: string | null;
};

// GET /api/v1/admin/maintenance/mounts
//
// Return current VARDO_MOUNT_1/2/3 values from env.
export async function GET() {
  try {
    await requireAppAdmin();

    const config: MountsConfig = {
      mount1: process.env.VARDO_MOUNT_1 || null,
      mount2: process.env.VARDO_MOUNT_2 || null,
      mount3: process.env.VARDO_MOUNT_3 || null,
    };

    // Filter out /dev/null as that's the default placeholder
    if (config.mount1 === "/dev/null") config.mount1 = null;
    if (config.mount2 === "/dev/null") config.mount2 = null;
    if (config.mount3 === "/dev/null") config.mount3 = null;

    return NextResponse.json(config);
  } catch (error) {
    return handleRouteError(error, "Error fetching mount configuration");
  }
}

// POST /api/v1/admin/maintenance/mounts
//
// Update VARDO_MOUNT_1/2/3 in /vardo/.env.
// Body: { mount1?: string, mount2?: string, mount3?: string }
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const vardoDir = process.env.VARDO_DIR;
    if (!vardoDir) {
      return NextResponse.json(
        { error: "VARDO_DIR not configured" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const envPath = `${vardoDir}/.env`;

    // Validate paths - they should be absolute paths or empty
    const mounts = ["mount1", "mount2", "mount3"] as const;
    for (const key of mounts) {
      const value = body[key];
      if (value && typeof value === "string" && value.trim() && !value.startsWith("/")) {
        return NextResponse.json(
          { error: `${key} must be an absolute path (starting with /)` },
          { status: 400 }
        );
      }
    }

    // Write each mount to the env file
    const mountKeys = {
      mount1: "VARDO_MOUNT_1",
      mount2: "VARDO_MOUNT_2",
      mount3: "VARDO_MOUNT_3",
    } as const;

    for (const [key, envKey] of Object.entries(mountKeys)) {
      const value = body[key as keyof typeof mountKeys];
      if (value !== undefined) {
        // Empty string or null = remove (set to placeholder)
        const envValue = value?.trim() || "/dev/null";
        await writeEnvKey(envPath, envKey, envValue);
        log.info("updated mount", { key: envKey, value: envValue });
      }
    }

    return NextResponse.json({
      success: true,
      restartRequired: true,
      message: "Mount configuration saved. Restart Vardo to apply changes.",
    });
  } catch (error) {
    return handleRouteError(error, "Error saving mount configuration");
  }
}
