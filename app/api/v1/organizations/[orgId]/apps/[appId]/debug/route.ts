import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAdmin } from "@/lib/auth/permissions";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  generateComposeForImage,
  parseCompose,
  sanitizeCompose,
  applyDeployTransforms,
  composeToYaml,
  type ComposeFile,
} from "@/lib/docker/compose";
import { listContainers, inspectContainer } from "@/lib/docker/client";
import { buildTraefikConfigYaml } from "@/lib/traefik/generate-config";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const NETWORK_NAME = "vardo-network";

/**
 * Build a compose preview from the app's stored configuration.
 * Applies the same transformation chain as deploy without cloning a repo
 * or building images.
 */
function buildComposePreview(
  app: {
    name: string;
    deployType: string;
    source: string;
    imageName: string | null;
    composeContent: string | null;
    containerPort: number | null;
    cpuLimit: number | null;
    memoryLimit: number | null;
    gpuEnabled: boolean;
    exposedPorts: { internal: number; external?: number; protocol?: string }[] | null;
    domains: { id: string; domain: string; port: number | null; sslEnabled: boolean | null; certResolver: string | null; redirectTo: string | null; redirectCode: number | null }[];
  },
  volumesList: { name: string; mountPath: string }[],
): ComposeFile | null {
  let compose: ComposeFile | null = null;

  if (app.deployType === "image" && app.composeContent) {
    // Imported container — use stored compose
    try {
      const parsed = parseCompose(app.composeContent);
      const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: true });
      compose = sanitized;
    } catch {
      return null;
    }
  } else if (app.deployType === "image" && app.imageName) {
    compose = generateComposeForImage({
      projectName: app.name,
      imageName: app.imageName,
      containerPort: app.containerPort ?? undefined,
      volumes: volumesList.length > 0 ? volumesList : undefined,
      exposedPorts: app.exposedPorts ?? undefined,
    });
  } else if (app.composeContent) {
    // Stored compose content (git repos with inline compose)
    try {
      const parsed = parseCompose(app.composeContent);
      const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: true });
      compose = sanitized;
    } catch {
      return null;
    }
  } else {
    // Git repo — compose is generated during build, not available statically
    return null;
  }

  if (!compose) return null;

  return applyDeployTransforms(compose, {
    appName: app.name,
    containerPort: app.containerPort,
    cpuLimit: app.cpuLimit,
    memoryLimit: app.memoryLimit,
    gpuEnabled: app.gpuEnabled,
    domains: app.domains,
    networkName: NETWORK_NAME,
  });
}

// GET /api/v1/organizations/[orgId]/apps/[appId]/debug
async function handler(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!isAdmin(org.membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      with: { domains: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, appId),
    });
    const volumesList = appVolumes
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));

    // Generate compose preview
    const composeParsed = buildComposePreview(
      {
        name: app.name,
        deployType: app.deployType,
        source: app.source,
        imageName: app.imageName,
        composeContent: app.composeContent,
        containerPort: app.containerPort,
        cpuLimit: app.cpuLimit ?? null,
        memoryLimit: app.memoryLimit ?? null,
        gpuEnabled: app.gpuEnabled,
        exposedPorts: app.exposedPorts as { internal: number; external?: number; protocol?: string }[] | null,
        domains: app.domains.map((d) => ({
          id: d.id,
          domain: d.domain,
          port: d.port ?? null,
          sslEnabled: d.sslEnabled ?? null,
          certResolver: d.certResolver ?? null,
          redirectTo: d.redirectTo ?? null,
          redirectCode: d.redirectCode ?? null,
        })),
      },
      volumesList,
    );

    const compose = composeParsed ? composeToYaml(composeParsed) : null;

    // Generate Traefik config
    const traefikConfig = buildTraefikConfigYaml(
      app.name,
      app.domains.map((d) => ({
        id: d.id,
        domain: d.domain,
        sslEnabled: d.sslEnabled ?? null,
        certResolver: d.certResolver ?? null,
        redirectTo: d.redirectTo ?? null,
        redirectCode: d.redirectCode ?? null,
      })),
    );

    // Get container inspect data — env vars are stripped to avoid exposing
    // secrets that are encrypted at rest in the database.
    let containers: unknown[] = [];
    try {
      const containerList = await listContainers(app.name);
      const inspectResults = await Promise.allSettled(
        containerList.map((c) => inspectContainer(c.id)),
      );
      containers = inspectResults
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof inspectContainer>>> => r.status === "fulfilled")
        .map((r) => {
          // Strip env — secrets are encrypted at rest and must not be exposed here
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { env, ...rest } = r.value;
          return rest;
        });
    } catch {
      // Docker not available — return empty
    }

    return NextResponse.json({ compose, traefikConfig, containers });
  } catch (error) {
    return handleRouteError(error, "Error loading debug info");
  }
}

export const GET = withRateLimit(handler, { tier: "admin", key: "app-debug" });
