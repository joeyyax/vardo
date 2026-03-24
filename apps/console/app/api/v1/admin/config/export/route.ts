import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAdminAuth } from "@/lib/auth/admin";
import { systemSettingsToVardoConfig } from "@/lib/config/vardo-config";
import YAML from "yaml";
import JSZip from "jszip";

/**
 * GET /api/v1/admin/config/export?include=config|full|secrets
 *
 * Export system configuration as YAML.
 * - config (default): vardo.yml only (safe to share)
 * - full: vardo.zip with both files
 * - secrets: vardo.secrets.yml only
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const include = request.nextUrl.searchParams.get("include") || "config";
    const { config, secrets } = await systemSettingsToVardoConfig();

    if (include === "config") {
      const yaml = YAML.stringify(config, { indent: 2 });
      return new NextResponse(yaml, {
        headers: {
          "Content-Type": "application/x-yaml",
          "Content-Disposition": "attachment; filename=\"vardo.yml\"",
        },
      });
    }

    if (include === "secrets") {
      const yaml = YAML.stringify(secrets, { indent: 2 });
      return new NextResponse(yaml, {
        headers: {
          "Content-Type": "application/x-yaml",
          "Content-Disposition": "attachment; filename=\"vardo.secrets.yml\"",
        },
      });
    }

    // Full export — zip both files
    const zip = new JSZip();
    zip.file("vardo.yml", YAML.stringify(config, { indent: 2 }));
    zip.file("vardo.secrets.yml", YAML.stringify(secrets, { indent: 2 }));

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=\"vardo.zip\"",
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error exporting config");
  }
}
