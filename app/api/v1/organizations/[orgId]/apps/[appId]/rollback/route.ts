import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { createSSEResponse } from "@/lib/api/sse";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { decrypt, encrypt } from "@/lib/crypto/encrypt";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAdmin } from "@/lib/auth/permissions";

const rollbackSchema = z.object({
  deploymentId: z.string().min(1, "deploymentId is required"),
  includeEnvVars: z.boolean().default(false),
}).strict();

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// POST /api/v1/organizations/[orgId]/apps/[appId]/rollback
// Body: { deploymentId: string, includeEnvVars?: boolean }
// Returns SSE stream of deploy log lines (same as normal deploy)
async function handler(request: NextRequest, { params }: { params: Promise<{ orgId: string; appId: string }> }) {
  const { orgId, appId } = await params;

  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Parse body
    let body: { deploymentId?: string; includeEnvVars?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = rollbackSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { deploymentId, includeEnvVars } = parsed.data;

    // Fetch the app
    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId),
      ),
      columns: {
        id: true,
        organizationId: true,
        gitUrl: true,
        gitBranch: true,
        imageName: true,
        envContent: true,
        cpuLimit: true,
        memoryLimit: true,
        gpuEnabled: true,
        containerPort: true,
        composeFilePath: true,
        rootDirectory: true,
        restartPolicy: true,
        autoTraefikLabels: true,
      },
    });

    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    // Fetch the target deployment (the one we are rolling back to)
    const targetDeployment = await db.query.deployments.findFirst({
      where: and(
        eq(deployments.id, deploymentId),
        eq(deployments.appId, appId),
      ),
      columns: {
        id: true,
        status: true,
        gitSha: true,
        gitMessage: true,
        envSnapshot: true,
        configSnapshot: true,
      },
    });

    if (!targetDeployment) {
      return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
    }

    if (targetDeployment.status !== "success") {
      return NextResponse.json(
        { error: "Can only roll back to a successful deployment" },
        { status: 400 },
      );
    }

    const configSnapshot = targetDeployment.configSnapshot as ConfigSnapshot | null;

    // Rolling back to a snapshot with GPU passthrough enabled restores host hardware
    // access — gate it the same way as enabling GPU via PATCH.
    if (configSnapshot?.gpuEnabled === true && !isAdmin(org.membership.role)) {
      return NextResponse.json(
        { error: "Only owners and admins can roll back to a snapshot with GPU passthrough enabled" },
        { status: 403 },
      );
    }

    // Trigger a new deploy through the normal blue-green flow.
    // Config and env changes are applied AFTER the deploy succeeds
    // to avoid leaving the app record in an inconsistent state on failure.
    return createSSEResponse(request, async (sendEvent) => {
      const result = await requestDeploy({
        appId,
        organizationId: orgId,
        trigger: "rollback",
        triggeredBy: org.session.user.id,
        onLog: (line) => sendEvent("log", line),
        onStage: (stg, status) => sendEvent("stage", { stage: stg, status }),
      });

      // Tag the new deployment with rollback source
      try {
        await db
          .update(deployments)
          .set({ rollbackFromId: deploymentId })
          .where(eq(deployments.id, result.deploymentId));
      } catch { /* best-effort */ }

      // Apply config snapshot and env restore only after a successful deploy
      if (result.success) {
        const appUpdates: Record<string, unknown> = { updatedAt: new Date() };

        if (configSnapshot) {
          appUpdates.cpuLimit = configSnapshot.cpuLimit;
          appUpdates.memoryLimit = configSnapshot.memoryLimit;
          appUpdates.gpuEnabled = configSnapshot.gpuEnabled ?? false;
          appUpdates.containerPort = configSnapshot.containerPort;
          appUpdates.imageName = configSnapshot.imageName;
          appUpdates.gitBranch = configSnapshot.gitBranch;
          appUpdates.composeFilePath = configSnapshot.composeFilePath;
          appUpdates.rootDirectory = configSnapshot.rootDirectory;
          appUpdates.restartPolicy = configSnapshot.restartPolicy;
          appUpdates.autoTraefikLabels = configSnapshot.autoTraefikLabels;
        }

        if (includeEnvVars && targetDeployment.envSnapshot) {
          try {
            const plainEnv = decrypt(targetDeployment.envSnapshot, orgId);
            appUpdates.envContent = encrypt(plainEnv, orgId);
          } catch {
            // If decryption fails, skip env restore
          }
        }

        await db.update(apps).set(appUpdates).where(eq(apps.id, appId));
      }

      sendEvent("done", {
        deploymentId: result.deploymentId,
        success: result.success,
        durationMs: result.durationMs,
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error rolling back deployment");
  }
}

// GET /api/v1/organizations/[orgId]/apps/[appId]/rollback?deploymentId=xxx
// Returns a diff preview of what will change if rolling back to the given deployment
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const deploymentId = request.nextUrl.searchParams.get("deploymentId");
    if (!deploymentId) {
      return NextResponse.json({ error: "deploymentId query param required" }, { status: 400 });
    }

    // Fetch app current state
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: {
        id: true,
        organizationId: true,
        envContent: true,
        cpuLimit: true,
        memoryLimit: true,
        gpuEnabled: true,
        containerPort: true,
        imageName: true,
        gitBranch: true,
        composeFilePath: true,
        rootDirectory: true,
        restartPolicy: true,
        autoTraefikLabels: true,
      },
    });

    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    // Fetch target deployment
    const targetDeployment = await db.query.deployments.findFirst({
      where: and(
        eq(deployments.id, deploymentId),
        eq(deployments.appId, appId),
      ),
      columns: {
        id: true,
        gitSha: true,
        gitMessage: true,
        envSnapshot: true,
        configSnapshot: true,
        startedAt: true,
      },
    });

    if (!targetDeployment) {
      return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
    }

    // Build config diff
    const configSnapshot = targetDeployment.configSnapshot as ConfigSnapshot | null;

    const configChanges: { field: string; from: string | null; to: string | null }[] = [];

    if (configSnapshot) {
      const fields: { key: keyof typeof configSnapshot; label: string }[] = [
        { key: "cpuLimit", label: "CPU Limit" },
        { key: "memoryLimit", label: "Memory Limit" },
        { key: "gpuEnabled", label: "GPU Access" },
        { key: "containerPort", label: "Container Port" },
        { key: "imageName", label: "Image" },
        { key: "gitBranch", label: "Git Branch" },
        { key: "composeFilePath", label: "Compose File" },
        { key: "rootDirectory", label: "Root Directory" },
        { key: "restartPolicy", label: "Restart Policy" },
        { key: "autoTraefikLabels", label: "Auto Traefik Labels" },
      ];

      for (const { key, label } of fields) {
        const current = String(app[key] ?? "");
        const snapshot = String(configSnapshot[key] ?? "");
        if (current !== snapshot) {
          configChanges.push({
            field: label,
            from: app[key] != null ? String(app[key]) : null,
            to: configSnapshot[key] != null ? String(configSnapshot[key]) : null,
          });
        }
      }
    }

    // Build env var diff (key-level only, no values exposed)
    let envKeyChanges: { added: string[]; removed: string[]; changed: string[] } | null = null;

    if (targetDeployment.envSnapshot) {
      try {
        const { parseEnvToMap } = await import("@/lib/env/parse-env");
        const { decryptOrFallback } = await import("@/lib/crypto/encrypt");

        const snapshotPlain = decrypt(targetDeployment.envSnapshot, orgId);
        const snapshotMap = parseEnvToMap(snapshotPlain);

        let currentMap: Record<string, string> = {};
        if (app.envContent) {
          const { content } = decryptOrFallback(app.envContent, orgId);
          if (content) currentMap = parseEnvToMap(content);
        }

        const snapshotKeys = new Set(Object.keys(snapshotMap));
        const currentKeys = new Set(Object.keys(currentMap));

        const added = [...snapshotKeys].filter((k) => !currentKeys.has(k));
        const removed = [...currentKeys].filter((k) => !snapshotKeys.has(k));
        const changed = [...snapshotKeys].filter(
          (k) => currentKeys.has(k) && currentMap[k] !== snapshotMap[k],
        );

        envKeyChanges = { added, removed, changed };
      } catch {
        // Can't compute diff
      }
    }

    return NextResponse.json({
      deploymentId: targetDeployment.id,
      gitSha: targetDeployment.gitSha,
      gitMessage: targetDeployment.gitMessage,
      deployedAt: targetDeployment.startedAt,
      hasEnvSnapshot: !!targetDeployment.envSnapshot,
      hasConfigSnapshot: !!configSnapshot,
      configChanges,
      envKeyChanges,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching rollback preview");
  }
}

export const POST = withRateLimit(handler, { tier: "critical", key: "rollback" });
