import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { db } from "@/lib/db";
import { apps, deployments, environments, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { discoverContainers, getContainerDetail, isLocalImage } from "@/lib/docker/discover";
import { slugify } from "@/lib/ui/slugify";
import { generateComposeFromContainer, composeToYaml } from "@/lib/docker/compose";
import type { ComposeFile } from "@/lib/docker/compose";
import { recordActivity } from "@/lib/activity";
import { stopContainer, startContainer, removeContainer } from "@/lib/docker/client";
import { createDeployment } from "@/lib/docker/deploy";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { publishEvent, appChannel } from "@/lib/events";

type RouteParams = {
  params: Promise<{ orgId: string; composeProject: string }>;
};

const importGroupSchema = z.object({
  projectId: z.string().nullable().optional(),
  newProjectName: z.string().min(1).optional(),
  displayName: z.string().min(1, "Display name is required"),
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
});

// POST /api/v1/organizations/[orgId]/discover/groups/[composeProject]/import
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, composeProject } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Validate composeProject — only allow safe identifiers
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(composeProject)) {
      return NextResponse.json({ error: "Invalid compose project name" }, { status: 400 });
    }

    const body = await request.json();
    const parsed = importGroupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const data = parsed.data;

    // Discover all unmanaged containers and find those in this compose group
    const discovery = await discoverContainers();
    const group = discovery.groups.find((g) => g.composeProject === composeProject);
    if (!group || group.containers.length === 0) {
      return NextResponse.json(
        { error: "Compose group not found or already managed" },
        { status: 404 }
      );
    }

    // Inspect each container for full detail (env, mounts, labels, etc.)
    const details = await Promise.all(
      group.containers.map((c) => getContainerDetail(c.id))
    );

    const validDetails = details.filter((d) => d !== null);
    if (validDetails.length === 0) {
      return NextResponse.json(
        { error: "No importable containers found in this compose group" },
        { status: 404 }
      );
    }

    // Build a multi-service compose file by merging individual container configs.
    // Use the com.docker.compose.service label as the service name, falling back
    // to the container name slugified.
    const merged: ComposeFile = { services: {} };

    for (const detail of validDetails) {
      const serviceName =
        (detail.labels["com.docker.compose.service"] ?? slugify(detail.name)) || slugify(detail.name);

      const singleFile = generateComposeFromContainer(serviceName, {
        image: detail.image,
        ports: detail.ports,
        mounts: detail.mounts,
        networkMode: detail.networkMode,
        restartPolicy: detail.restartPolicy,
        capAdd: detail.capAdd,
        capDrop: detail.capDrop,
        devices: detail.devices,
        privileged: detail.privileged,
        securityOpt: detail.securityOpt,
        shmSize: detail.shmSize,
        init: detail.init,
        extraHosts: detail.extraHosts,
        nanoCpus: detail.nanoCpus,
        memoryBytes: detail.memoryBytes,
        ulimits: detail.ulimits,
        tmpfs: detail.tmpfs,
        hostname: detail.hostname,
        user: detail.user,
        stopSignal: detail.stopSignal,
        healthcheck: detail.healthcheck,
        entrypoint: detail.entrypoint,
        command: detail.command,
        labels: detail.labels,
        hasEnvVars: false,
      });

      // Merge this service into the combined file
      for (const [name, svc] of Object.entries(singleFile.services)) {
        merged.services[name] = svc;
      }

      // Merge named volume declarations
      if (singleFile.volumes) {
        merged.volumes ??= {};
        for (const [volName, volDef] of Object.entries(singleFile.volumes)) {
          merged.volumes[volName] = volDef;
        }
      }
    }

    const composeContent = composeToYaml(merged);

    let result: { app: (typeof apps)["$inferSelect"] };
    try {
      result = await db.transaction(async (tx) => {
        // Resolve projectId — create new project if requested
        let resolvedProjectId: string | null = data.projectId ?? null;

        if (data.newProjectName) {
          const newProjectId = nanoid();
          const newProjectSlug = slugify(data.newProjectName);
          await tx.insert(projects).values({
            id: newProjectId,
            organizationId: orgId,
            name: newProjectSlug,
            displayName: data.newProjectName,
          });
          resolvedProjectId = newProjectId;
        } else if (resolvedProjectId) {
          const project = await tx.query.projects.findFirst({
            where: and(eq(projects.id, resolvedProjectId), eq(projects.organizationId, orgId)),
            columns: { id: true },
          });
          if (!project) {
            throw new Error("PROJECT_NOT_FOUND");
          }
        }

        // Insert parent app record for the compose stack
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
            autoTraefikLabels: false,
            projectId: resolvedProjectId,
            status: "active",
          })
          .returning();

        // Auto-create production environment
        await tx.insert(environments).values({
          id: nanoid(),
          appId,
          name: "production",
          type: "production",
          isDefault: true,
        });

        return { app };
      });
    } catch (txError) {
      if (txError instanceof Error && txError.message === "PROJECT_NOT_FOUND") {
        return NextResponse.json({ error: "Project not found" }, { status: 400 });
      }
      throw txError;
    }

    const { app } = result;
    const appId = app.id;

    const warnings: string[] = [];

    // Warn about local images and host networking
    for (const detail of validDetails) {
      if (isLocalImage(detail.image)) {
        warnings.push(
          `Service "${detail.labels["com.docker.compose.service"] ?? detail.name}" uses a local image — Vardo won't be able to redeploy without pushing to a registry first.`
        );
      }
      if (detail.networkMode === "host") {
        warnings.push(
          `Service "${detail.labels["com.docker.compose.service"] ?? detail.name}" uses host networking — no port mapping or automatic domain routing is available.`
        );
      }
    }

    recordActivity({
      organizationId: orgId,
      action: "app.imported",
      appId,
      userId: org.session.user.id,
      metadata: {
        name: data.name,
        displayName: data.displayName,
        composeProject,
        serviceCount: validDetails.length,
      },
    });

    // Pre-create deployment record, then migrate async
    const deploymentId = await createDeployment({
      appId,
      organizationId: orgId,
      trigger: "api",
      triggeredBy: org.session.user.id,
    });

    const containerIds = validDetails.map((d) => d.id);

    void (async () => {
      const stoppedIds: string[] = [];

      // Stop all containers in the group
      for (const containerId of containerIds) {
        try {
          await stopContainer(containerId);
          stoppedIds.push(containerId);
        } catch {
          // If we can't stop all containers, leave running ones and bail
        }
      }

      try {
        const deployResult = await requestDeploy({
          appId,
          organizationId: orgId,
          trigger: "api",
          triggeredBy: org.session.user.id,
          deploymentId,
        });

        if (!deployResult.success) {
          throw new Error(deployResult.log || "Deployment did not succeed");
        }
      } catch {
        // Restart originals so the services keep running
        if (stoppedIds.length > 0) {
          let anyRestarted = false;
          for (const containerId of stoppedIds) {
            try {
              await startContainer(containerId);
              anyRestarted = true;
            } catch {
              // Best effort
            }
          }

          if (anyRestarted) {
            await db
              .update(deployments)
              .set({ status: "rolled_back", finishedAt: new Date() })
              .where(eq(deployments.id, deploymentId));

            await db
              .update(apps)
              .set({ status: "active", updatedAt: new Date() })
              .where(eq(apps.id, appId));

            publishEvent(appChannel(appId), {
              event: "deploy:rolled_back",
              appId,
              deploymentId,
              message: "Import deploy failed — original containers restarted",
            }).catch(() => {});

            recordActivity({
              organizationId: orgId,
              action: "deployment.rolled_back",
              appId,
              metadata: { deploymentId, composeProject, source: "group-import" },
            }).catch(() => {});

            import("@/lib/notifications/dispatch").then(({ emit }) => {
              emit(orgId, {
                type: "deploy.rollback",
                title: `Import deploy failed: ${data.displayName}`,
                message: "Import deploy failed — original containers restarted",
                projectName: data.displayName,
                appId,
                rollbackSuccess: true,
              });
            }).catch(() => {});
          }
        }
        return;
      }

      // Deployment succeeded — remove original containers
      for (const containerId of containerIds) {
        try {
          await removeContainer(containerId, { force: true });
        } catch {
          // Non-fatal
        }
      }
    })();

    return NextResponse.json({ app, warnings, deploymentId, migrated: false }, { status: 201 });
  } catch (error) {
    const pgCode =
      error instanceof Error
        ? ("code" in error ? (error as { code: string }).code : null) ??
          (error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause
            ? (error.cause as { code: string }).code
            : null)
        : null;
    if (pgCode === "23505") {
      return NextResponse.json(
        { error: "An app with this slug already exists in this organization" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error importing compose group");
  }
}
