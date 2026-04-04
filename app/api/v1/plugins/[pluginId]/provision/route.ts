import { NextRequest, NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getCurrentOrg } from "@/lib/auth/session";
import { getPlugin } from "@/lib/plugins/registry";
import { provisionService, deprovisionService } from "@/lib/plugins/provision";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { z } from "zod";

type RouteParams = { params: Promise<{ pluginId: string }> };

const provisionSchema = z.object({
  serviceName: z.string().min(1),
});

// POST /api/v1/plugins/[pluginId]/provision
// Provisions a backing service for a plugin
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAppAdmin();

    const { pluginId } = await params;
    const orgData = await getCurrentOrg();
    if (!orgData) {
      return NextResponse.json({ error: "No active organization" }, { status: 400 });
    }
    const organizationId = orgData.organization.id;

    const body = await request.json();
    const parsed = provisionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const { serviceName } = parsed.data;

    // Look up plugin manifest and find the matching service requirement
    const manifest = getPlugin(pluginId);
    if (!manifest) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }

    const service = manifest.requires?.services?.find(
      (s) => s.name === serviceName,
    );
    if (!service) {
      return NextResponse.json(
        { error: `Plugin "${pluginId}" has no service requirement named "${serviceName}"` },
        { status: 400 },
      );
    }

    if (!service.provisionable) {
      return NextResponse.json(
        { error: `Service "${serviceName}" is not provisionable` },
        { status: 400 },
      );
    }

    if (!service.templateName) {
      return NextResponse.json(
        { error: `No template configured for service "${serviceName}"` },
        { status: 400 },
      );
    }

    const { appId } = await provisionService(pluginId, service, organizationId);

    return NextResponse.json(
      { appId, message: `Provisioning ${serviceName} — deploy started` },
      { status: 202 },
    );
  } catch (error) {
    return handleRouteError(error, "Error provisioning plugin service");
  }
}

// DELETE /api/v1/plugins/[pluginId]/provision
// Deprovisions a previously provisioned backing service
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAppAdmin();

    const { pluginId } = await params;
    const orgData = await getCurrentOrg();
    if (!orgData) {
      return NextResponse.json({ error: "No active organization" }, { status: 400 });
    }
    const organizationId = orgData.organization.id;

    const url = new URL(request.url);
    const serviceName = url.searchParams.get("serviceName");
    if (!serviceName) {
      return NextResponse.json(
        { error: "serviceName query parameter required" },
        { status: 400 },
      );
    }

    await deprovisionService(pluginId, serviceName, organizationId);

    return NextResponse.json({ success: true, message: `Deprovisioned ${serviceName}` });
  } catch (error) {
    return handleRouteError(error, "Error deprovisioning plugin service");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "plugin-provision" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "plugin-provision" });
