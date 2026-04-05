import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, volumes, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isOrgAdmin } from "@/lib/auth/permissions";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  buildComposePreview,
  composeToYaml,
  resolveBackendProtocol,
  narrowBackendProtocol,
} from "@/lib/docker/compose";
import { listContainers, inspectContainer } from "@/lib/docker/client";
import { buildTraefikConfigYaml } from "@/lib/ssl/generate-config";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const NETWORK_NAME = "vardo-network";
// Cap the serialized container inspect payload to avoid returning MB+ for multi-service apps
const CONTAINER_INSPECT_MAX_BYTES = 256 * 1024; // 256KB

// GET /api/v1/organizations/[orgId]/apps/[appId]/debug
async function handler(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!isOrgAdmin(org.membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [app, appVolumes] = await Promise.all([
      db.query.apps.findFirst({
        where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
        with: { domains: true },
      }),
      db.query.volumes.findMany({
        where: eq(volumes.appId, appId),
      }),
    ]);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const volumesList = appVolumes
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));

    // Resolve per-project bind mount permission so the preview matches deploy.
    const orgTrusted = org.organization.trusted ?? false;
    let projectAllowBindMounts = false;
    if (orgTrusted) {
      projectAllowBindMounts = true;
    } else if (app.projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, app.projectId),
        columns: { allowBindMounts: true },
      });
      projectAllowBindMounts = project?.allowBindMounts ?? false;
    }

    // Resolve the effective backend protocol for the debug preview
    const resolvedProtocol = resolveBackendProtocol(
      narrowBackendProtocol(app.backendProtocol),
      app.containerPort ?? 3000,
    );

    // Generate compose preview
    const composeParsed = buildComposePreview(
      {
        name: app.name,
        deployType: app.deployType,
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
        backendProtocol: narrowBackendProtocol(app.backendProtocol),
      },
      volumesList,
      NETWORK_NAME,
      orgTrusted,
      projectAllowBindMounts,
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
      resolvedProtocol,
    );

    // Get container inspect data — env vars are stripped to avoid exposing
    // secrets that are encrypted at rest in the database.
    let containers: unknown[] = [];
    try {
      const containerList = await listContainers(app.name);
      const inspectResults = await Promise.allSettled(
        containerList.map((c) => inspectContainer(c.id)),
      );
      let totalBytes = 0;
      containers = inspectResults
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof inspectContainer>>> => r.status === "fulfilled")
        .flatMap((r) => {
          // Strip env — secrets are encrypted at rest and must not be exposed here
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { env, ...rest } = r.value;
          const serialized = JSON.stringify(rest);
          totalBytes += serialized.length;
          if (totalBytes > CONTAINER_INSPECT_MAX_BYTES) return [];
          return [rest];
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
