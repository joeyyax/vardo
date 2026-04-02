import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { z } from "zod";
import {
  getAllIntegrations,
  connectAppIntegration,
  connectExternalIntegration,
  disconnectIntegration,
  type IntegrationType,
} from "@/lib/integrations";

const VALID_TYPES = ["metrics", "error_tracking", "uptime", "logging"] as const;

const connectAppSchema = z.object({
  type: z.enum(VALID_TYPES),
  mode: z.literal("app"),
  appId: z.string().min(1, "App ID is required"),
  config: z.record(z.string(), z.unknown()).optional(),
});

const connectExternalSchema = z.object({
  type: z.enum(VALID_TYPES),
  mode: z.literal("external"),
  externalUrl: z.string().url("Must be a valid URL"),
  apiToken: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const connectSchema = z.discriminatedUnion("mode", [
  connectAppSchema,
  connectExternalSchema,
]);

// GET /api/v1/admin/integrations — list all integrations
export async function GET() {
  try {
    await requireAppAdmin();
    const integrations = await getAllIntegrations();
    return NextResponse.json({ integrations });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching integrations");
  }
}

// POST /api/v1/admin/integrations — connect an integration
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = connectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const data = parsed.data;
    let integration;

    if (data.mode === "app") {
      integration = await connectAppIntegration(data.type, data.appId, data.config);
    } else {
      integration = await connectExternalIntegration(
        data.type,
        data.externalUrl,
        data.apiToken,
        data.config,
      );
    }

    return NextResponse.json({ integration }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error connecting integration");
  }
}

// DELETE /api/v1/admin/integrations — disconnect an integration by type
export async function DELETE(request: NextRequest) {
  try {
    await requireAppAdmin();

    const type = request.nextUrl.searchParams.get("type");
    if (!type || !VALID_TYPES.includes(type as IntegrationType)) {
      return NextResponse.json(
        { error: "Invalid integration type" },
        { status: 400 },
      );
    }

    await disconnectIntegration(type as IntegrationType);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error disconnecting integration");
  }
}
