import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { apps, environments, volumes, domains, organizations, deployments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { loadTemplates } from "@/lib/templates/load";
import { generateSubdomain } from "@/lib/domains/auto-domain";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { connectAppIntegration, disconnectIntegration, type IntegrationType } from "@/lib/integrations";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { getSession } from "@/lib/auth/session";
import { recordActivity } from "@/lib/activity";
import { subscribe, appChannel } from "@/lib/events";
import { listContainers } from "@/lib/docker/client";

const HEALTH_CHECK_TIMEOUT = 60 * 1000; // 60 seconds
import { logger } from "@/lib/logger";

const log = logger.child("integrations");

const VALID_TYPES = ["metrics", "error_tracking", "uptime", "logging"] as const;

const TEMPLATE_MAP: Record<string, string> = {
  metrics: "cadvisor",
  error_tracking: "glitchtip",
  uptime: "uptime-kuma",
};

const installSchema = z.object({
  type: z.enum(VALID_TYPES),
  name: z.string().min(1).max(64).optional(),
  gpu: z.boolean().optional().default(false),
});

type InstallStage =
  | "template_render"
  | "app_create"
  | "env_setup"
  | "deploy_start"
  | "deploy_progress"
  | "health_check"
  | "complete"
  | "failed"
  | "rollback";

interface InstallEvent {
  stage: InstallStage;
  message: string;
  progress?: number;
  appId?: string;
  deploymentId?: string;
  error?: string;
  canRetry?: boolean;
}

// POST /api/v1/admin/integrations/install/stream
// SSE stream for integration install with live deploy progress
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();
    const session = await getSession();

    const body = await request.json();
    const parsed = installSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { type, name: customName, gpu } = parsed.data;
    const templateName = TEMPLATE_MAP[type];
    if (!templateName) {
      return new Response(
        JSON.stringify({ error: `No template available for ${type}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const encoder = new TextEncoder();

    // Build SSE stream
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch { /* client disconnected */ }
        };

        const sendStage = (stage: InstallStage, message: string, extra?: Partial<InstallEvent>) => {
          send("stage", { stage, message, ...extra });
        };

        let appId: string | null = null;
        let deploymentId: string | null = null;
        let unsubscribes: (() => void)[] = [];

        const cleanup = () => {
          unsubscribes.forEach(fn => fn());
          unsubscribes = [];
        };

        request.signal.addEventListener("abort", () => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        });

        try {
          // Stage 1: Template render
          sendStage("template_render", `Loading ${templateName} template...`, { progress: 5 });

          const templates = await loadTemplates();
          const template = templates.find((t) => t.name === templateName);
          if (!template) {
            sendStage("failed", `Template "${templateName}" not found`, { progress: 100, canRetry: false });
            controller.close();
            return;
          }

          // Get org
          const { getCurrentOrg } = await import("@/lib/auth/session");
          const orgData = await getCurrentOrg();
          if (!orgData) {
            sendStage("failed", "No active organization", { progress: 100, canRetry: false });
            controller.close();
            return;
          }
          const orgId = orgData.organization.id;

          const org = await db.query.organizations.findFirst({
            where: eq(organizations.id, orgId),
            columns: { id: true, baseDomain: true },
          });
          if (!org) {
            sendStage("failed", "Organization not found", { progress: 100, canRetry: false });
            controller.close();
            return;
          }

          // Stage 2: App creation
          sendStage("app_create", "Creating integration app...", { progress: 15 });

          appId = nanoid();
          const appName = customName || template.name;

          await db.insert(apps).values({
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
            gpuEnabled: gpu,
          });

          sendStage("env_setup", "Setting up environment and volumes...", { progress: 25, appId });

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

          // Stage 3: Deploy start
          sendStage("deploy_start", "Starting deployment...", { progress: 35, appId });

          // Subscribe to deploy events before kicking off deploy
          let deployComplete = false;
          let deploySuccess = false;
          const deployChannel = appChannel(appId);

          const unsub = subscribe(deployChannel, (data) => {
            const event = data.event as string;

            if (event === "deploy:log") {
              send("log", { deploymentId: data.deploymentId, message: data.message });
            } else if (event === "deploy:stage") {
              send("stage", {
                stage: "deploy_progress",
                message: `Deploy stage: ${data.stage}`,
                progress: 40 + Math.min(data.status === "running" ? 30 : 45, 45),
                deploymentId: data.deploymentId,
              });
            } else if (event === "deploy:complete") {
              deployComplete = true;
              deploySuccess = data.success as boolean;
              deploymentId = data.deploymentId as string;
              send("stage", {
                stage: "deploy_progress",
                message: data.success ? "Deployment complete" : "Deployment failed",
                progress: data.success ? 75 : 50,
                deploymentId: data.deploymentId,
              });
            } else if (event === "deploy:rolled_back") {
              send("stage", {
                stage: "rollback",
                message: data.message as string,
                progress: 50,
              });
            }
          });
          unsubscribes.push(unsub);

          // Kick off deploy
          const deployPromise = requestDeploy({
            appId,
            organizationId: orgId,
            trigger: "manual",
            triggeredBy: session?.user?.id ?? "system",
          });

          // Wait for deploy to start
          await deployPromise;

          // Poll for deployment to start (race condition handling)
          let pollCount = 0;
          const maxPolls = 30;
          while (!deploymentId && pollCount < maxPolls) {
            await new Promise(r => setTimeout(r, 500));
            const runningDeploy = await db.query.deployments.findFirst({
              where: and(eq(deployments.appId, appId), eq(deployments.status, "running")),
              orderBy: [desc(deployments.startedAt)],
            });
            if (runningDeploy) {
              deploymentId = runningDeploy.id;
            }
            pollCount++;
          }

          if (!deploymentId) {
            sendStage("failed", "Deployment failed to start", { progress: 100, appId, canRetry: true });
            cleanup();
            controller.close();
            return;
          }

          // Wait for deploy to complete (with timeout)
          const deployTimeout = 10 * 60 * 1000; // 10 minutes
          const startTime = Date.now();
          while (!deployComplete && Date.now() - startTime < deployTimeout) {
            await new Promise(r => setTimeout(r, 500));
          }

          if (!deployComplete) {
            sendStage("failed", "Deployment timed out", { progress: 100, appId, deploymentId, canRetry: true });
            cleanup();
            controller.close();
            return;
          }

          if (!deploySuccess) {
            sendStage("failed", "Deployment failed. Check the app logs for details.", {
              progress: 100,
              appId,
              deploymentId,
              canRetry: true,
            });
            cleanup();
            controller.close();
            return;
          }

          // Stage 4: Health check
          sendStage("health_check", "Verifying integration health...", { progress: 80, appId, deploymentId });

          // Get app name for health check
          const appRecord = await db.query.apps.findFirst({
            where: eq(apps.id, appId),
            columns: { name: true },
          });

          // Quick health check - verify app is running
          const healthCheckResult = await performHealthCheck(appId, appRecord?.name ?? "");

          if (!healthCheckResult.healthy) {
            // Rollback: disconnect integration
            try {
              await disconnectIntegration(type as IntegrationType);
              sendStage("rollback", "Health check failed - rolled back integration", {
                progress: 100,
                appId,
                deploymentId,
                error: healthCheckResult.error,
                canRetry: true,
              });
            } catch {
              sendStage("failed", `Health check failed: ${healthCheckResult.error}`, {
                progress: 100,
                appId,
                deploymentId,
                canRetry: true,
              });
            }
            cleanup();
            controller.close();
            return;
          }

          // Stage 5: Connect integration
          sendStage("complete", "Integration connected successfully!", {
            progress: 100,
            appId,
            deploymentId,
          });

          // Connect integration (upsert)
          await connectAppIntegration(type as IntegrationType, appId, { gpu });

          // Hot-swap provider if metrics
          if (type === "metrics") {
            const { reinitMetricsProvider } = await import("@/lib/metrics/config");
            await reinitMetricsProvider();
          }

          recordActivity({
            organizationId: orgId,
            action: "app.created",
            appId,
            userId: session?.user?.id ?? "system",
            metadata: { name: appName, displayName: template.displayName, source: "integration-install", type },
          });

          cleanup();
          controller.close();

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          log.error("Integration install failed:", error);

          // Attempt rollback on failure
          if (appId) {
            try {
              await disconnectIntegration(type as IntegrationType);
            } catch { /* rollback failed, continue */ }
          }

          sendStage("failed", errorMsg, { progress: 100, appId: appId ?? undefined, canRetry: true });
          cleanup();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Unique constraint — app name already exists
    const pgCode = error instanceof Error
      ? ("code" in error ? (error as { code: string }).code : null) ??
        (error.cause && typeof error.cause === "object" && "code" in error.cause ? (error.cause as { code: string }).code : null)
      : null;
    if (pgCode === "23505") {
      return new Response(
        JSON.stringify({ error: "An app with this name already exists. Connect it manually instead." }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    return handleRouteError(error, "Error installing integration");
  }
}

async function performHealthCheck(appId: string, appName: string): Promise<{ healthy: boolean; error?: string }> {
  const startTime = Date.now();

  while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT) {
    try {
      // List containers and look for one with matching app label
      const containers = await listContainers();
      const container = containers.find(c =>
        c.labels["vardo.appId"] === appId ||
        c.labels["host.appId"] === appId ||
        c.name === appName
      );

      if (container) {
        if (container.state === "running") {
          return { healthy: true };
        }
        if (container.state === "exited" || container.state === "dead") {
          return { healthy: false, error: `Container is ${container.state}: ${container.status}` };
        }
      }

      // Wait before retry
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      // Continue polling on transient errors
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return { healthy: false, error: "Health check timed out - container did not become ready" };
}
