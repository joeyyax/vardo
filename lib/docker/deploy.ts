import { db } from "@/lib/db";
import { deployments, projects, domains, envVars } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

type DeployOpts = {
  projectId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api" | "rollback";
  triggeredBy?: string;
  environmentId?: string;
};

type DeployResult = {
  deploymentId: string;
  success: boolean;
  log: string;
  durationMs: number;
};

export async function createDeployment(opts: DeployOpts): Promise<string> {
  const [deployment] = await db
    .insert(deployments)
    .values({
      id: nanoid(),
      projectId: opts.projectId,
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy,
      status: "queued",
      environmentId: opts.environmentId,
    })
    .returning({ id: deployments.id });

  return deployment.id;
}

export async function runDeployment(
  deploymentId: string,
  opts: DeployOpts
): Promise<DeployResult> {
  const startTime = Date.now();
  const logs: string[] = [];

  try {
    // Mark as running
    await db
      .update(deployments)
      .set({ status: "running" })
      .where(eq(deployments.id, deploymentId));

    logs.push(`[deploy] Starting deployment ${deploymentId}`);

    // Fetch project
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, opts.projectId),
        eq(projects.organizationId, opts.organizationId)
      ),
      with: {
        domains: true,
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    logs.push(`[deploy] Project: ${project.displayName} (${project.name})`);
    logs.push(`[deploy] Source: ${project.source}, Deploy type: ${project.deployType}`);

    // Fetch env vars (unscoped or matching environment)
    const projectEnvVars = await db.query.envVars.findMany({
      where: eq(envVars.projectId, opts.projectId),
    });

    logs.push(`[deploy] ${projectEnvVars.length} environment variables`);
    logs.push(`[deploy] ${project.domains.length} domain(s) configured`);

    // TODO: Generate compose file from project config
    // TODO: Inject Traefik labels for each domain
    // TODO: Inject shared network
    // TODO: Write compose file to project directory
    // TODO: Run docker compose up -d
    // TODO: Wait for health check
    // TODO: Update project status

    logs.push(`[deploy] Compose file generation — not yet implemented`);
    logs.push(`[deploy] Docker compose up — not yet implemented`);

    // Mark project as active (placeholder)
    await db
      .update(projects)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(projects.id, opts.projectId));

    // Mark deployment as success
    const durationMs = Date.now() - startTime;
    await db
      .update(deployments)
      .set({
        status: "success",
        log: logs.join("\n"),
        durationMs,
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));

    return { deploymentId, success: true, log: logs.join("\n"), durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logs.push(`[deploy] ERROR: ${message}`);

    const durationMs = Date.now() - startTime;

    await db
      .update(deployments)
      .set({
        status: "failed",
        log: logs.join("\n"),
        durationMs,
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));

    await db
      .update(projects)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(projects.id, opts.projectId));

    return { deploymentId, success: false, log: logs.join("\n"), durationMs };
  }
}

export async function deployProject(opts: DeployOpts): Promise<DeployResult> {
  const deploymentId = await createDeployment(opts);
  return runDeployment(deploymentId, opts);
}
