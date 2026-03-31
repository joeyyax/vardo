import { NextResponse } from "next/server";
import { readdir } from "fs/promises";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";

// GET /api/v1/admin/docker
//
// Returns Docker configuration info including EXTERNAL_PROJECTS_PATH.
export async function GET() {
  try {
    await requireAppAdmin();

    const externalProjectsPath = process.env.EXTERNAL_PROJECTS_PATH || null;
    const vardoRole = process.env.VARDO_ROLE || "unknown";

    // Check if the path is accessible and list directories
    let accessible = false;
    let directories: string[] = [];

    if (externalProjectsPath && externalProjectsPath !== "/dev/null") {
      try {
        const entries = await readdir(externalProjectsPath, { withFileTypes: true });
        directories = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort();
        accessible = true;
      } catch {
        accessible = false;
      }
    }

    return NextResponse.json({
      externalProjectsPath: externalProjectsPath === "/dev/null" ? null : externalProjectsPath,
      vardoRole,
      configured: !!externalProjectsPath && externalProjectsPath !== "/dev/null",
      accessible,
      directories,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching Docker configuration");
  }
}
