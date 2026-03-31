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
import { apps, organizations } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child("self-preview");

const execFileAsync = promisify(execFile);

const PREVIEW_PROJECT_PREFIX = "vardo-preview-pr";
const VARDO_NETWORK = "vardo-network";

// Stale preview threshold: tear down previews older than this many hours when
// cleanupStaleSelfPreviews() runs. Handles missed PR close webhooks.
const STALE_PREVIEW_MAX_AGE_HOURS = 72;

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
 *
 * Scoped to the first-created organization — the same org selfManagement
 * registers apps under (see self-register.ts). This matches the org-scoped
 * pattern used everywhere else and ensures results never cross tenant
 * boundaries if the partial unique index is ever relaxed.
 */
export async function getSystemManagedApp(repoFullName: string) {
  const gitUrl = `https://github.com/${repoFullName}.git`;

  // selfManagement registers apps under the first-created organization.
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(asc(organizations.createdAt))
    .limit(1);

  if (!org) return null;

  return db.query.apps.findFirst({
    where: and(
      eq(apps.gitUrl, gitUrl),
      eq(apps.isSystemManaged, true),
      eq(apps.organizationId, org.id)
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

  // Validate prNumber — used in filesystem paths and container names.
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  // Allowlist branch name characters. Must start with an alphanumeric character
  // (rules out git flag injection like --upload-pack) and only contain the chars
  // that appear in real-world branch names. execFile already prevents shell
  // injection, but an allowlist is a stronger guarantee.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.~-]*$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  // Validate repoFullName before constructing the clone URL.
  // HMAC verification upstream makes exploitation unlikely, but this function
  // runs git clone and manages temp dirs — defensive validation is appropriate.
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) {
    throw new Error(`Invalid repo name: ${repoFullName}`);
  }

  const projectName = `${PREVIEW_PROJECT_PREFIX}-${prNumber}`;
  const previewDir = join(tmpdir(), projectName);

  const { baseDomain } = await getInstanceConfig();

  // Validate baseDomain before string-concatenating it into YAML labels.
  // baseDomain is admin-configured, so direct user exploitation isn't possible,
  // but a stray backtick, newline, or YAML-special char would produce malformed
  // compose output.
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(baseDomain)) {
    throw new Error(`Invalid baseDomain in instance config: ${baseDomain}`);
  }

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

  // Write env file with restrictive permissions — avoids YAML escaping issues
  // with connection strings, and limits exposure of secrets at rest.
  const routerName = `vardo-pr-${prNumber}`;
  const envFileContent = buildEnvFile();
  const envFilePath = join(previewDir, ".preview.env");
  await writeFile(envFilePath, envFileContent, { encoding: "utf-8", mode: 0o600 });

  // Write the preview compose file
  const composeContent = buildPreviewCompose({ domain, routerName });
  await writeFile(join(previewDir, "docker-compose.preview.yml"), composeContent, "utf-8");

  log.info(`[self-preview] Starting preview for PR #${prNumber} at ${domain}`);
  let buildError: Error | null = null;
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
    buildError = err instanceof Error ? err : new Error(String(err));
  } finally {
    // Remove the env file — the containers have already read it at startup.
    // On failure this ensures credentials don't remain in /tmp indefinitely.
    await rm(envFilePath, { force: true }).catch(() => {});
  }

  if (buildError) {
    throw new Error(`Vardo preview build failed for PR #${prNumber}: ${buildError.message}`);
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
// Cleanup stale previews
// ---------------------------------------------------------------------------

/**
 * Find and destroy self-preview containers that have been running longer than
 * STALE_PREVIEW_MAX_AGE_HOURS. Handles the case where a PR close webhook was
 * missed, which would otherwise leave preview containers running indefinitely.
 *
 * Call this from a periodic maintenance job.
 */
export async function cleanupStaleSelfPreviews(
  maxAgeHours = STALE_PREVIEW_MAX_AGE_HOURS
): Promise<number> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "docker",
      [
        "ps",
        "--filter", `name=${PREVIEW_PROJECT_PREFIX}-`,
        "--format", "{{.Names}}\t{{.CreatedAt}}",
      ],
      { timeout: 30_000 }
    ));
  } catch (err) {
    log.warn(`[self-preview] docker ps failed during stale cleanup: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  if (!stdout.trim()) return 0;

  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const seen = new Set<number>();
  let cleaned = 0;

  for (const line of stdout.trim().split("\n")) {
    const [containerName, createdAt] = line.split("\t");
    if (!containerName || !createdAt) continue;

    // Container names are: {projectName}-{service}-{index}
    // e.g. vardo-preview-pr-42-vardo-1
    const match = containerName.match(/^vardo-preview-pr-(\d+)-/);
    if (!match) continue;

    const prNumber = parseInt(match[1], 10);
    if (isNaN(prNumber) || seen.has(prNumber)) continue;
    seen.add(prNumber);

    const createdMs = new Date(createdAt).getTime();
    if (isNaN(createdMs) || createdMs > cutoffMs) continue;

    log.info(`[self-preview] Cleaning up stale preview for PR #${prNumber} (created: ${createdAt})`);
    try {
      await destroyVardoPreview(prNumber);
      cleaned++;
    } catch (err) {
      log.error(`[self-preview] Stale cleanup failed for PR #${prNumber}:`, err);
    }
  }

  return cleaned;
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

/**
 * Build the .preview.env file content. Only passes through secrets that are
 * required for the frontend-only preview — encryption keys and auth secrets
 * are intentionally excluded so PR contributors cannot access production
 * secrets or forge session tokens.
 *
 * DATABASE isolation:
 * Set PREVIEW_DATABASE_URL (and optionally PREVIEW_REDIS_URL) to point preview
 * containers at an isolated database — a read-only replica, a seeded sandbox,
 * or a separate Postgres role with restricted permissions. This is strongly
 * recommended when selfManagement is enabled.
 *
 * If PREVIEW_DATABASE_URL is not set, DATABASE_URL (production) is used as a
 * fallback. This exposes the production database to preview container code.
 * Only acceptable when PR access is restricted to trusted contributors and the
 * repo is not public. See the selfManagement feature docs for details.
 */
export function buildEnvFile(): string {
  const lines = [
    "VARDO_PREVIEW=true",
    "SKIP_MIGRATIONS=true",
  ];

  // Prefer isolated preview DB/cache; fall back to production if not configured.
  // ENCRYPTION_MASTER_KEY and BETTER_AUTH_SECRET are intentionally omitted —
  // preview instances do not need to decrypt stored secrets or issue sessions.
  const dbUrl = process.env.PREVIEW_DATABASE_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    const sanitized = dbUrl.replace(/\r?\n/g, " ");
    lines.push(`DATABASE_URL=${sanitized}`);
  }

  const redisUrl = process.env.PREVIEW_REDIS_URL || process.env.REDIS_URL;
  if (redisUrl) {
    const sanitized = redisUrl.replace(/\r?\n/g, " ");
    lines.push(`REDIS_URL=${sanitized}`);
  }

  return lines.join("\n") + "\n";
}

export function buildPreviewCompose(opts: {
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
