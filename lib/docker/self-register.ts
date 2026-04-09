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
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { parseCompose } from "@/lib/docker/compose";
import { ensureVardoOrg } from "@/lib/infra/vardo-org";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR, VARDO_CURRENT_DIR } from "@/lib/paths";

const execFileAsync = promisify(execFile);

const log = logger.child("self-register");

// Infrastructure services managed as child app records.
// cadvisor, loki, and promtail are provisioned separately via lib/infra/provision.ts.
const INFRA_SERVICES = new Set([
  "postgres",
  "redis",
  "traefik",
  "wireguard",
]);

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

  // Warn operators who haven't configured an isolated preview database.
  // Without PREVIEW_DATABASE_URL, preview containers fall back to the
  // production DATABASE_URL — acceptable only for private repos with
  // trusted contributors, but easy to misconfigure silently.
  if (!process.env.PREVIEW_DATABASE_URL) {
    log.warn(
      "selfManagement is enabled but PREVIEW_DATABASE_URL is not set — " +
      "preview containers will use the production database. " +
      "Set PREVIEW_DATABASE_URL in .env to point previews at an isolated database."
    );
  }

  // Read and parse the compose file to discover service names.
  const composePath = join(vardoDir, "docker-compose.yml");
  const composeContent = await readFile(composePath, "utf-8");
  const compose = parseCompose(composeContent);

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
    // Normalize SSH URLs to HTTPS.
    if (gitUrl.startsWith("git@")) {
      gitUrl = gitUrl
        .replace(/^git@([^:]+):/, "https://$1/")
        .replace(/\.git$/, "");
    }

    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["-C", vardoDir, "branch", "--show-current"],
      { timeout: 5000 },
    );
    gitBranch = branchOut.trim() || null;
  } catch {
    // Not a git repo or no remote — proceed without git info.
  }

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
        displayName: "Vardo",
        isSystemManaged: true,
        allowBindMounts: true,
      })
      .onConflictDoUpdate({
        target: [projects.organizationId, projects.name],
        set: {
          displayName: "Vardo",
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
      })
      .onConflictDoUpdate({
        target: [apps.organizationId, apps.name],
        set: {
          projectId: project.id,
          gitUrl,
          gitBranch: gitBranch ?? "main",
          isSystemManaged: true,
          composeContent,
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
  });
}
