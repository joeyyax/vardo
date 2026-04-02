import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { apps, environments, volumes, domains, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { loadTemplates } from "@/lib/templates/load";
import { generateSubdomain } from "@/lib/domains/auto-domain";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { connectAppIntegration, type IntegrationType } from "@/lib/integrations";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { getSession } from "@/lib/auth/session";
import { recordActivity } from "@/lib/activity";

const VALID_TYPES = ["metrics", "error_tracking", "uptime", "logging"] as const;

const TEMPLATE_MAP: Record<string, string> = {
  metrics: "cadvisor",
  error_tracking: "glitchtip",
  uptime: "uptime-kuma",
};

const installSchema = z.object({
  type: z.enum(VALID_TYPES),
});

// POST /api/v1/admin/integrations/install
// One-click: create app from template + connect integration + deploy
export async function POST(request: NextRequest) {
  try {
    const admin = await requireAppAdmin();
    const session = await getSession();

    const body = await request.json();
    const parsed = installSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const { type } = parsed.data;
    const templateName = TEMPLATE_MAP[type];
    if (!templateName) {
      return NextResponse.json(
        { error: `No template available for ${type}` },
        { status: 400 },
      );
    }

    // Load template
    const templates = await loadTemplates();
    const template = templates.find((t) => t.name === templateName);
    if (!template) {
      return NextResponse.json(
        { error: `Template "${templateName}" not found` },
        { status: 404 },
      );
    }

    // Get admin's current org
    const { getCurrentOrg } = await import("@/lib/auth/session");
    const orgData = await getCurrentOrg();
    if (!orgData) {
      return NextResponse.json({ error: "No active organization" }, { status: 400 });
    }
    const orgId = orgData.organization.id;

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { id: true, baseDomain: true },
    });
    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // Create the app
    const appId = nanoid();
    const appName = template.name;
    const [app] = await db
      .insert(apps)
      .values({
        id: appId,
        organizationId: orgId,
        name: appName,
        displayName: template.displayName,
        description: template.description,
        source: template.source as "git" | "direct",
        deployType: template.deployType as "compose" | "image",
        imageName: template.imageName,
        composeContent: template.composeContent,
        containerPort: template.defaultPort,
        templateName: template.name,
        cpuLimit: template.defaultCpuLimit,
        memoryLimit: template.defaultMemoryLimit,
        diskWriteAlertThreshold: template.defaultDiskWriteAlertThreshold,
        persistentVolumes: template.defaultVolumes?.map((v) => ({
          name: v.name,
          mountPath: v.mountPath,
        })),
        connectionInfo: template.defaultConnectionInfo,
      })
      .returning();

    // Create production environment
    await db.insert(environments).values({
      id: nanoid(),
      appId,
      name: "production",
      type: "production",
      isDefault: true,
    });

    // Create volumes
    if (template.defaultVolumes?.length) {
      for (const vol of template.defaultVolumes) {
        await db.insert(volumes).values({
          id: nanoid(),
          appId,
          organizationId: orgId,
          name: vol.name,
          mountPath: vol.mountPath,
          persistent: true,
        });
      }
    }

    // Auto-generate domain
    const sslConfig = await getSslConfig();
    const autoDomain = generateSubdomain(appName, org.baseDomain);
    if (autoDomain) {
      await db.insert(domains).values({
        id: nanoid(),
        appId,
        domain: autoDomain,
        port: template.defaultPort,
        certResolver: getPrimaryIssuer(sslConfig),
      });
    }

    // Connect the integration
    await connectAppIntegration(type as IntegrationType, appId);

    // Hot-swap provider if metrics
    if (type === "metrics") {
      const { reinitMetricsProvider } = await import("@/lib/metrics/config");
      await reinitMetricsProvider();
    }

    // Kick off deploy in the background (don't await — let it run)
    requestDeploy({
      appId,
      organizationId: orgId,
      trigger: "manual",
      triggeredBy: session?.user?.id ?? "system",
    }).catch(() => {}); // deploy failures are tracked in the deployment record

    recordActivity({
      organizationId: orgId,
      action: "app.created",
      appId,
      userId: session?.user?.id ?? "system",
      metadata: { name: appName, displayName: template.displayName, source: "integration-install" },
    });

    return NextResponse.json({
      app: { id: appId, name: appName, displayName: template.displayName },
      integration: { type, status: "connected", appId },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Unique constraint — app name already exists
    const pgCode = error instanceof Error
      ? ("code" in error ? (error as { code: string }).code : null) ??
        (error.cause && typeof error.cause === "object" && "code" in error.cause ? (error.cause as { code: string }).code : null)
      : null;
    if (pgCode === "23505") {
      return NextResponse.json(
        { error: "An app with this name already exists. Connect it manually instead." },
        { status: 409 },
      );
    }
    return handleRouteError(error, "Error installing integration");
  }
}
