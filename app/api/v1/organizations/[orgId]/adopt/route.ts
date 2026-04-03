import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps, domains, environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  parseCompose,
  sanitizeCompose,
  injectNetwork,
  composeToYaml,
  excludeServices,
} from "@/lib/docker/compose";
import type { ComposeFile } from "@/lib/docker/compose";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { encrypt } from "@/lib/crypto/encrypt";
import { resolveProjectForImport } from "@/lib/docker/import";
import { regenerateAppRouteConfig } from "@/lib/traefik/generate-config";
import { logger } from "@/lib/logger";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const environmentConfigSchema = z.object({
  domain: z.string().optional(),
  exclude: z.array(z.string()).optional(),
});

const adoptSchema = z.object({
  composeContent: z.string().min(1, "Compose content is required"),
  projectConfig: z
    .object({
      name: z.string().optional(),
      environments: z.record(z.string(), environmentConfigSchema).optional(),
      env: z.array(z.string()).optional(),
      resources: z
        .object({
          memory: z.string().optional(),
          cpus: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  environmentType: z
    .enum(["local", "production", "staging", "preview"])
    .default("local"),
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "Display name is required").max(255),
  projectId: z.string().nullable().optional(),
  newProjectName: z.string().min(1).max(255).optional(),
  domain: z.string().optional(),
  containerPort: z.number().int().positive().optional(),
});

// POST /api/v1/organizations/[orgId]/adopt
async function handler(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = adoptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Check for duplicate slug
    const existingBySlug = await db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), eq(apps.name, data.name)),
      columns: { id: true },
    });
    if (existingBySlug) {
      return NextResponse.json(
        {
          error: "An app with this slug already exists in this organization",
          appId: existingBySlug.id,
        },
        { status: 409 }
      );
    }

    // Parse and process compose content
    let compose: ComposeFile;
    try {
      compose = parseCompose(data.composeContent);
    } catch {
      return NextResponse.json(
        { error: "Invalid docker-compose content" },
        { status: 400 }
      );
    }

    // Apply exclusions from vardo.yml project config
    const envConfig =
      data.projectConfig?.environments?.[data.environmentType];
    const excludeList = envConfig?.exclude ?? [];
    if (excludeList.length > 0) {
      compose = excludeServices(compose, excludeList);
    }

    // Sanitize (bind mounts allowed for local environments)
    const { compose: sanitized } = sanitizeCompose(compose, {
      allowBindMounts: data.environmentType === "local",
    });
    compose = sanitized;

    // Determine domain — explicit > vardo.yml env config > default
    const domain =
      data.domain ?? envConfig?.domain ?? `${data.name}.localhost`;
    const containerPort = data.containerPort ?? 3000;

    // Inject Traefik labels and network
    const sslConfig = await getSslConfig();
    const certResolver = getPrimaryIssuer(sslConfig);

    // Inject shared network for all services
    compose = injectNetwork(compose, "vardo-network");

    const composeContent = composeToYaml(compose);

    // Determine primary service and container name for Traefik routing
    const primaryServiceName = Object.keys(compose.services)[0];
    const containerName = primaryServiceName
      ? `${data.name}-${primaryServiceName}-1`
      : `${data.name}-1`;

    // Build encrypted env content if project config declares env vars
    const envContent: string | null = null;

    const result = await db.transaction(async (tx) => {
      const resolvedProjectId = await resolveProjectForImport(
        tx,
        orgId,
        data.projectId,
        data.newProjectName
      );

      const appId = nanoid();
      const [app] = await tx
        .insert(apps)
        .values({
          id: appId,
          organizationId: orgId,
          name: data.name,
          displayName: data.displayName,
          source: "direct",
          deployType: "compose",
          composeContent,
          autoTraefikLabels: true,
          containerPort,
          containerName,
          projectId: resolvedProjectId,
          envContent,
          status: "active",
        })
        .returning();

      // Create environment with the requested type
      await tx.insert(environments).values({
        id: nanoid(),
        appId,
        name: data.environmentType,
        type: data.environmentType,
        domain,
        isDefault: true,
      });

      // Create domain record
      await tx.insert(domains).values({
        id: nanoid(),
        appId,
        domain,
        port: containerPort,
        certResolver,
        isPrimary: true,
      });

      return { app };
    });

    // Generate Traefik config (app-level label management)
    regenerateAppRouteConfig(result.app.id).catch((err) =>
      logger.child("adopt").error("Failed to regenerate route config:", err)
    );

    recordActivity({
      organizationId: orgId,
      action: "app.adopted",
      appId: result.app.id,
      userId: org.session.user.id,
      metadata: {
        name: data.name,
        displayName: data.displayName,
        environmentType: data.environmentType,
        excludedServices: excludeList,
      },
    });

    return NextResponse.json(
      {
        app: result.app,
        environmentType: data.environmentType,
        domain,
      },
      { status: 201 }
    );
  } catch (error) {
    return handleRouteError(error, "Error adopting compose project");
  }
}

export const POST = withRateLimit(handler, {
  tier: "mutation",
  key: "adopt",
});
