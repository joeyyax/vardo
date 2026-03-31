// ---------------------------------------------------------------------------
// Vardo self-preview deployer
//
// Deploys a frontend-only preview of Vardo when a PR is opened against the
// Vardo repo. This is a specialized path — not the generic deploy engine.
//
// Safety constraints:
//   - No Docker socket mount
//   - No VARDO_DIR mount
//   - SKIP_MIGRATIONS=true (prevents DB migrations on boot)
//   - VARDO_PREVIEW=true (webhook handler returns early on preview instances)
//
// The preview container joins the existing vardo-network and reuses the
// running vardo-postgres and vardo-redis services.
// ---------------------------------------------------------------------------

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child("self-preview");

const execFileAsync = promisify(execFile);

const PREVIEW_PROJECT_PREFIX = "vardo-preview-pr";
const VARDO_NETWORK = "vardo-network";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateVardoPreviewOpts = {
  prNumber: number;
  branch: string;
  repoFullName: string;
};

export type VardoPreviewResult = {
  domain: string;
  projectName: string;
};

// ---------------------------------------------------------------------------
// Query helper
// ---------------------------------------------------------------------------

/**
 * Find an app that is system-managed and linked to the given GitHub repo.
 * Returns null if no matching app exists.
 */
export async function getSystemManagedApp(repoFullName: string) {
  const gitUrl = `https://github.com/${repoFullName}.git`;
  return db.query.apps.findFirst({
    where: and(
      eq(apps.gitUrl, gitUrl),
      eq(apps.isSystemManaged, true)
    ),
  });
}

// ---------------------------------------------------------------------------
// Create preview
// ---------------------------------------------------------------------------

/**
 * Clone the Vardo repo at the PR branch, generate a single-service compose
 * file, and spin up the frontend container with Traefik routing.
 *
 * If a preview already exists for this PR (e.g. a force-push), the old
 * containers are torn down before rebuilding.
 */
export async function createVardoPreview(
  opts: CreateVardoPreviewOpts
): Promise<VardoPreviewResult> {
  const { prNumber, branch, repoFullName } = opts;
  const projectName = `${PREVIEW_PROJECT_PREFIX}-${prNumber}`;
  const previewDir = join(tmpdir(), projectName);

  const { baseDomain } = await getInstanceConfig();
  const domain = `vardo-pr-${prNumber}.${baseDomain}`;

  // Tear down any existing preview for this PR before rebuilding
  await _teardown(projectName).catch(() => {
    // Ignore — containers may not exist on first run
  });

  // Clean up any leftover temp dir
  await rm(previewDir, { recursive: true, force: true });
  await mkdir(previewDir, { recursive: true });

  log.info(`[self-preview] Cloning ${repoFullName}@${branch} into ${previewDir}`);
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--branch", branch, `https://github.com/${repoFullName}.git`, "."],
    { cwd: previewDir, timeout: 120_000 }
  );

  // Write env file — avoids YAML escaping issues with connection strings
  const routerName = `vardo-pr-${prNumber}`;
  const envFileContent = buildEnvFile();
  await writeFile(join(previewDir, ".preview.env"), envFileContent, "utf-8");

  // Write the preview compose file
  const composeContent = buildPreviewCompose({ domain, routerName });
  await writeFile(join(previewDir, "docker-compose.preview.yml"), composeContent, "utf-8");

  log.info(`[self-preview] Starting preview for PR #${prNumber} at ${domain}`);
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      [
        "compose",
        "-f", "docker-compose.preview.yml",
        "-p", projectName,
        "up", "-d", "--build",
      ],
      { cwd: previewDir, timeout: 600_000 }
    );
    if (stdout.trim()) log.info(`[self-preview] ${stdout.trim()}`);
    if (stderr.trim()) log.info(`[self-preview] ${stderr.trim()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Vardo preview build failed for PR #${prNumber}: ${message}`);
  }

  return { domain, projectName };
}

// ---------------------------------------------------------------------------
// Destroy preview
// ---------------------------------------------------------------------------

/**
 * Tear down the preview containers (including volumes) and remove the
 * temporary directory.
 */
export async function destroyVardoPreview(prNumber: number): Promise<void> {
  const projectName = `${PREVIEW_PROJECT_PREFIX}-${prNumber}`;
  const previewDir = join(tmpdir(), projectName);

  log.info(`[self-preview] Destroying preview for PR #${prNumber}`);
  await _teardown(projectName);
  await rm(previewDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _teardown(projectName: string): Promise<void> {
  try {
    await execFileAsync(
      "docker",
      ["compose", "-p", projectName, "down", "--volumes"],
      { timeout: 60_000 }
    );
  } catch (err) {
    log.warn(
      `[self-preview] docker compose down failed (may already be stopped): ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function buildEnvFile(): string {
  const lines = [
    "VARDO_PREVIEW=true",
    "SKIP_MIGRATIONS=true",
  ];

  // Pass through critical runtime secrets so the preview instance is functional.
  // The preview joins vardo-network and reads from the production DB.
  const passthroughKeys = [
    "DATABASE_URL",
    "REDIS_URL",
    "ENCRYPTION_MASTER_KEY",
    "BETTER_AUTH_SECRET",
  ];

  for (const key of passthroughKeys) {
    const value = process.env[key];
    if (value) lines.push(`${key}=${value}`);
  }

  return lines.join("\n") + "\n";
}

function buildPreviewCompose(opts: {
  domain: string;
  routerName: string;
}): string {
  const { domain, routerName } = opts;

  const lines = [
    "services:",
    "  vardo:",
    "    build:",
    "      context: .",
    "      dockerfile: Dockerfile",
    "    env_file:",
    "      - .preview.env",
    "    networks:",
    `      - ${VARDO_NETWORK}`,
    "    labels:",
    `      - "traefik.enable=true"`,
    `      - "traefik.http.routers.${routerName}.rule=Host(\`${domain}\`)"`,
    `      - "traefik.http.routers.${routerName}.tls=true"`,
    `      - "traefik.http.routers.${routerName}.tls.certresolver=le"`,
    `      - "traefik.http.services.${routerName}.loadbalancer.server.port=3000"`,
    "    restart: unless-stopped",
    "networks:",
    `  ${VARDO_NETWORK}:`,
    "    external: true",
  ];

  return lines.join("\n") + "\n";
}
