import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { enqueueDeploy } from "@/lib/deploy/queue";
import { tailDeployment } from "@/lib/stream/deploy-tail";
import { createSSEResponse } from "@/lib/api/sse";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { decrypt } from "@/lib/crypto/encrypt";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { can } from "@/lib/auth/permissions";
import { refuseSystemManaged } from "@/lib/api/system-managed";

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
    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org) return apiError.forbidden();

    let body: { deploymentId?: string; includeEnvVars?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = rollbackSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }
    const { deploymentId, includeEnvVars } = parsed.data;
    if (includeEnvVars && !can(org.membership, "env.write")) {
      return NextResponse.json({ error: "Restoring env vars needs permission to change them" }, { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId),
      ),
      columns: { id: true, organizationId: true, isSystemManaged: true },
    });

    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    const refused = refuseSystemManaged(app, "rollback");
    if (refused) return refused;

    const targetDeployment = await db.query.deployments.findFirst({
      where: and(
        eq(deployments.id, deploymentId),
        eq(deployments.appId, appId),
      ),
      columns: { id: true, status: true, configSnapshot: true },
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

    // A GPU-enabled snapshot restores host hardware access; gate it like PATCH.
    if (configSnapshot?.gpuEnabled === true && !can(org.membership, "app.gpu")) {
      return NextResponse.json(
        { error: "Only owners and admins can roll back to a snapshot with GPU passthrough enabled" },
        { status: 403 },
      );
    }

    // Deploys the target's snapshot; the engine rewrites the app row only once the deploy commits.
    const { id } = await enqueueDeploy({
      appId,
      trigger: "rollback",
      triggeredBy: org.session.user.id,
      rollback: { targetDeploymentId: deploymentId, includeEnvVars },
    });

    return createSSEResponse(request, async (sendEvent) => {
      const result = await tailDeployment(
        id,
        {
          onLog: (line) => sendEvent("log", line),
          onStage: (stg, status, meta) => sendEvent("stage", { stage: stg, status, streamId: meta.streamId }),
          onWait: (wait) => sendEvent("wait", { deploymentId: id, ...wait }),
          onStatus: (status) => sendEvent("status", { deploymentId: id, status }),
        },
        { signal: request.signal },
      );
      if (!result) return;
      sendEvent("done", {
        deploymentId: result.deploymentId,
        success: result.success,
        durationMs: result.durationMs,
        status: result.status,
        error: result.error,
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error rolling back deployment");
  }
}

// GET /api/v1/organizations/[orgId]/apps/[appId]/rollback?deploymentId=xxx
// Returns a diff preview of what will change if rolling back to the given deployment
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const deploymentId = request.nextUrl.searchParams.get("deploymentId");
    if (!deploymentId) {
      return NextResponse.json({ error: "deploymentId query param required" }, { status: 400 });
    }

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
        backendProtocol: true,
      },
    });

    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

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

    const configSnapshot = targetDeployment.configSnapshot as ConfigSnapshot | null;

    const configChanges: { field: string; from: string | null; to: string | null }[] = [];

    if (configSnapshot) {
      // Only snapshot fields that are also app columns are diffable.
      type DiffField = Extract<keyof ConfigSnapshot, keyof typeof app>;
      const fields: { key: DiffField; label: string }[] = [
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
        { key: "backendProtocol", label: "Backend Protocol" },
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

    // Env var diff: keys only, no values.
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

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/rollback" });
