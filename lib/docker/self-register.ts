// ---------------------------------------------------------------------------
// Vardo self-registration.
//
// When the selfManagement feature flag is on, this
// module upserts a project + apps representing Vardo itself into the database
// so it appears as a managed project in the dashboard.
//
// Safe to call on every startup — all writes are idempotent upserts.
// ---------------------------------------------------------------------------

import { readFile, access } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

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
import { VARDO_HOME_DIR, VARDO_CURRENT_DIR } from "@/lib/paths";
import type { ComposeService } from "@/lib/docker/compose-types";

const execFileAsync = promisify(execFile);

const log = logger.child("self-register");

// Fallback when the running checkout has no readable git remote. Must stay in
// the format getSystemManagedApp() matches: https host, no .git suffix.
const DEFAULT_REPO_URL = "https://github.com/joeyyax/vardo";

/** Compose service serving the dashboard. */
const FRONTEND_SERVICE = "frontend";

/** Port the frontend service listens on. */
const FRONTEND_PORT = 3000;

// Infrastructure services managed as child app records.
// cadvisor, loki, and promtail are provisioned separately via lib/infra/provision.ts.
const INFRA_SERVICES = new Set([
  "postgres",
  "redis",
  "traefik",
  "wireguard",
]);

/**
 * Warn when the frontend has not claimed its own Traefik labels.
 *
 * Its host, fallback, unknown-host and /_next routers are hand-written. Without
 * the marker a deploy would strip them and generate a single host router from
 * the app's domains, so IP access and the unknown-host page would stop working.
 */
function warnIfRoutingIsReplaceable(frontend: ComposeService | undefined): void {
  if (!frontend || isTraefikSelfRouted(frontend)) return;
  log.warn(
    `${FRONTEND_SERVICE} is missing the ${TRAEFIK_MANUAL_LABEL}="manual" label — a deploy would replace its hand-written Traefik routers`,
  );
}

/**
 * Ensure Vardo is registered as a managed project in the database.
 *
 * Checks the selfManagement feature flag before doing anything.
 * Creates or updates:
 *   - A project named "vardo"
 *   - A parent compose app representing the full Vardo stack
 *   - Child apps for each infrastructure service found in docker-compose.yml
 *
 * All writes are upserts — safe to call on every startup.
 */
export async function ensureVardoProject(): Promise<void> {
  if (!(await isFeatureEnabledAsync("selfManagement"))) return;

  // Resolve the Vardo source directory — prefer the active slot (blue/green
  // layout), fall back to VARDO_HOME_DIR root for legacy flat installs.
  let vardoDir = VARDO_CURRENT_DIR;
  try {
    await access(join(vardoDir, "docker-compose.yml"));
  } catch {
    vardoDir = VARDO_HOME_DIR;
  }

  if (!process.env.PREVIEW_DATABASE_URL) {
    const overridden = process.env.VARDO_ALLOW_PREVIEW_PROD_DB === "true";
    log.warn(
      overridden
        ? "PREVIEW_DATABASE_URL is not set and VARDO_ALLOW_PREVIEW_PROD_DB=true — previews will run PR code against the production database."
        : "PREVIEW_DATABASE_URL is not set, so preview creation will be refused. Set it to an isolated database to enable previews.",
    );
  }

  // Read and parse the compose file to discover service names.
  const composePath = join(vardoDir, "docker-compose.yml");
  const composeContent = await readFile(composePath, "utf-8");
  const compose = parseCompose(composeContent);

  warnIfRoutingIsReplaceable(compose.services[FRONTEND_SERVICE]);

  const org = await ensureVardoOrg();
  if (!org) {
    log.warn("no admin user yet, skipping self-registration");
    return;
  }

  // Resolve git info so the parent app knows where to pull from.
  let gitUrl: string | null = null;
  let gitBranch: string | null = null;
  try {
    const { stdout: remoteOut } = await execFileAsync(
      "git",
      ["-C", vardoDir, "remote", "get-url", "origin"],
      { timeout: 5000 },
    );
    gitUrl = remoteOut.trim();
    // Normalize SSH URLs to HTTPS. The .git suffix is stripped for both forms —
    // getSystemManagedApp() matches on the suffix-free URL.
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

  // A deploy needs somewhere to check out from; an empty git_url blocks it.
  if (!gitUrl) gitUrl = DEFAULT_REPO_URL;

  const infraServices = Object.keys(compose.services).filter((name) =>
    INFRA_SERVICES.has(name),
  );

  // Wrap all upserts in a transaction so a partial failure doesn't leave the
  // registration in an inconsistent state. All writes are idempotent upserts,
  // so the transaction is safe to re-run on restart if it fails mid-way.
  await db.transaction(async (tx) => {
    // Upsert the project.
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

    // Upsert the parent app (the compose app for the full Vardo stack).
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
          gitBranch: gitBranch ?? "main",
          isSystemManaged: true,
          composeContent,
          containerPort: FRONTEND_PORT,
          updatedAt: new Date(),
        },
      })
      .returning({ id: apps.id });

    if (!parentApp) throw new Error("failed to upsert Vardo parent app");

    // Upsert child apps for each infrastructure service present in the compose file.
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

    // Vardo's own stack is started by docker compose, not the deploy engine, so
    // it has no deployment history. Seed one record so rollback and history
    // views have an anchor. Status stays with the reconciler.
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
