// Registers Vardo itself as a managed project when selfManagement is on. Idempotent.

import { readFile } from "fs/promises";
import { join } from "path";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execFileAsync } from "@/lib/utils/exec";

import { db } from "@/lib/db";
import { apps, deployments, projects } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import {
  parseCompose,
  isTraefikSelfRouted,
  TRAEFIK_MANUAL_LABEL,
} from "@/lib/docker/compose";
import { ensureVardoOrg } from "@/lib/infra/vardo-org";
import { logger } from "@/lib/logger";
import { isSelfDeployLayout, resolveVardoDir } from "@/lib/paths";
import type { ComposeService } from "@/lib/docker/compose-types";

const log = logger.child("self-register");

// Must match getSystemManagedApp()'s format: https, no .git suffix.
const DEFAULT_REPO_URL = "https://github.com/joeyyax/vardo";

/** Compose service serving the dashboard. */
const FRONTEND_SERVICE = "frontend";

/** Port the frontend service listens on. */
const FRONTEND_PORT = 3000;

// Infrastructure services registered as child apps. cadvisor, loki and promtail live in lib/infra/provision.ts.
const INFRA_SERVICES = new Set([
  "postgres",
  "redis",
  "traefik",
  "wireguard",
]);

/** Warn when the frontend lacks the manual-routing marker; a deploy would replace its hand-written routers. */
function warnIfRoutingIsReplaceable(frontend: ComposeService | undefined): void {
  if (!frontend || isTraefikSelfRouted(frontend)) return;
  log.warn(
    `${FRONTEND_SERVICE} is missing the ${TRAEFIK_MANUAL_LABEL}="manual" label — a deploy would replace its hand-written Traefik routers`,
  );
}

/** Upsert the "vardo" project, its parent compose app and infra child apps. */
export async function ensureVardoProject(opts: { force?: boolean } = {}): Promise<void> {
  // A self-deploying instance needs its record to update at all.
  if (!opts.force && !isSelfDeployLayout() && !(await isFeatureEnabledAsync("selfManagement"))) return;

  const vardoDir = resolveVardoDir();

  if (!process.env.PREVIEW_DATABASE_URL) {
    const overridden = process.env.VARDO_ALLOW_PREVIEW_PROD_DB === "true";
    log.warn(
      overridden
        ? "PREVIEW_DATABASE_URL is not set and VARDO_ALLOW_PREVIEW_PROD_DB=true — previews will run PR code against the production database."
        : "PREVIEW_DATABASE_URL is not set, so preview creation will be refused. Set it to an isolated database to enable previews.",
    );
  }

  const composePath = join(vardoDir, "docker-compose.yml");
  const composeContent = await readFile(composePath, "utf-8");
  const compose = parseCompose(composeContent);

  warnIfRoutingIsReplaceable(compose.services[FRONTEND_SERVICE]);

  const org = await ensureVardoOrg();
  if (!org) {
    log.warn("no admin user yet, skipping self-registration");
    return;
  }

  let gitUrl: string | null = null;
  let gitBranch: string | null = null;
  try {
    const { stdout: remoteOut } = await execFileAsync(
      "git",
      ["-C", vardoDir, "remote", "get-url", "origin"],
      { timeout: 5000 },
    );
    gitUrl = remoteOut.trim();
    // Normalize to HTTPS without .git, as getSystemManagedApp() matches.
    if (gitUrl.startsWith("git@")) {
      gitUrl = gitUrl.replace(/^git@([^:]+):/, "https://$1/");
    }
    gitUrl = gitUrl.replace(/\.git$/, "");

    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["-C", vardoDir, "branch", "--show-current"],
      { timeout: 5000 },
    );
    gitBranch = branchOut.trim() || null;
  } catch (err) {
    log.warn(
      `could not read git remote from ${vardoDir}, falling back to ${DEFAULT_REPO_URL}: ${err instanceof Error ? err.message : err}`,
    );
  }

  // An empty git_url blocks deploys.
  if (!gitUrl) gitUrl = DEFAULT_REPO_URL;

  const infraServices = Object.keys(compose.services).filter((name) =>
    INFRA_SERVICES.has(name),
  );

  // Top-level names are unique instance-wide; the per-org upserts wouldn't catch another org holding it.
  const nameHolder = await db.query.apps.findFirst({
    where: and(eq(apps.name, "vardo"), isNull(apps.parentAppId)),
    columns: { organizationId: true },
  });
  if (nameHolder && nameHolder.organizationId !== org.id) {
    log.error(
      `cannot self-register: an app named "vardo" already exists in another organization`,
    );
    return;
  }

  await db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        id: nanoid(),
        organizationId: org.id,
        name: "vardo",
        displayName: "Core",
        isSystemManaged: true,
        allowBindMounts: true,
      })
      .onConflictDoUpdate({
        target: [projects.organizationId, projects.name],
        set: {
          displayName: "Core",
          isSystemManaged: true,
          allowBindMounts: true,
          updatedAt: new Date(),
        },
      })
      .returning({ id: projects.id });

    if (!project) throw new Error("failed to upsert Vardo project");

    const [parentApp] = await tx
      .insert(apps)
      .values({
        id: nanoid(),
        organizationId: org.id,
        projectId: project.id,
        name: "vardo",
        displayName: "Vardo",
        source: "git",
        gitUrl,
        gitBranch: gitBranch ?? "main",
        isSystemManaged: true,
        deployType: "compose",
        composeContent,
        containerPort: FRONTEND_PORT,
      })
      .onConflictDoUpdate({
        target: [apps.organizationId, apps.name],
        set: {
          projectId: project.id,
          gitUrl,
          // A detached checkout keeps the configured branch.
          ...(gitBranch ? { gitBranch } : {}),
          isSystemManaged: true,
          composeContent,
          containerPort: FRONTEND_PORT,
          updatedAt: new Date(),
        },
      })
      .returning({ id: apps.id });

    if (!parentApp) throw new Error("failed to upsert Vardo parent app");

    for (const service of infraServices) {
      await tx
        .insert(apps)
        .values({
          id: nanoid(),
          organizationId: org.id,
          projectId: project.id,
          name: `vardo-${service}`,
          displayName: service,
          source: "direct",
          isSystemManaged: true,
          deployType: "compose",
          parentAppId: parentApp.id,
          composeService: service,
        })
        .onConflictDoUpdate({
          target: [apps.organizationId, apps.name],
          set: {
            projectId: project.id,
            parentAppId: parentApp.id,
            composeService: service,
            isSystemManaged: true,
            updatedAt: new Date(),
          },
        });
    }

    // Seed one deployment so rollback and history have an anchor; compose started the stack.
    const existingDeploy = await tx.query.deployments.findFirst({
      where: and(
        eq(deployments.appId, parentApp.id),
        eq(deployments.status, "success"),
      ),
      columns: { id: true },
    });

    if (!existingDeploy) {
      const now = new Date();
      await tx.insert(deployments).values({
        id: nanoid(),
        appId: parentApp.id,
        status: "success",
        trigger: "api",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        log: "[self-register] Started via docker compose — registered as managed app",
      });
    }
  });
}
