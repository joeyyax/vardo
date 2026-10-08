// Frontend-only Vardo preview for PRs against the Vardo repo.
// No Docker socket or VARDO_HOME_DIR mount; SKIP_MIGRATIONS and VARDO_PREVIEW are always set.

import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { db } from "@/lib/db";
import { apps, organizations } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/system-settings";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { dockerEnv } from "@/lib/docker/docker-env";

const log = logger.child("self-preview");


const PREVIEW_PROJECT_PREFIX = "vardo-preview-pr";
const VARDO_NETWORK = process.env.VARDO_NETWORK ?? "vardo-network";

// VARDO_NETWORK is interpolated into the compose YAML.
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(VARDO_NETWORK)) {
  throw new Error(`Invalid VARDO_NETWORK: "${VARDO_NETWORK}"`);
}

// Previews older than this are torn down by cleanupStaleSelfPreviews().
const STALE_PREVIEW_MAX_AGE_HOURS = 72;

export type CreateVardoPreviewOpts = {
  prNumber: number;
  branch: string;
  repoFullName: string;
};

export type VardoPreviewResult = {
  domain: string;
  projectName: string;
};

/** System-managed app linked to the repo, scoped to the first-created org. Null if none. */
export async function getSystemManagedApp(repoFullName: string) {
  // Must match the format ensureVardoProject stores (no .git suffix).
  const gitUrl = `https://github.com/${repoFullName}`;

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

/** Clone the PR branch and start a single-service preview behind Traefik, replacing any existing one. */
export async function createVardoPreview(
  opts: CreateVardoPreviewOpts
): Promise<VardoPreviewResult> {
  const { prNumber, branch, repoFullName } = opts;

  if (!(await isFeatureEnabledAsync("previews")) || !(await isFeatureEnabledAsync("selfManagement"))) {
    throw new Error("Vardo previews need both Previews and Self-management enabled");
  }

  // Used in filesystem paths and container names.
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  // Leading alphanumeric blocks git flag injection (--upload-pack).
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.~-]*$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) {
    throw new Error(`Invalid repo name: ${repoFullName}`);
  }

  // Security: a preview runs PR code with write access to whatever database it's handed.
  if (!process.env.PREVIEW_DATABASE_URL && process.env.VARDO_ALLOW_PREVIEW_PROD_DB !== "true") {
    throw new Error(
      "PREVIEW_DATABASE_URL is not set, so this preview would run PR code against the production database. " +
      "Point it at an isolated database, or set VARDO_ALLOW_PREVIEW_PROD_DB=true to accept the risk.",
    );
  }

  const projectName = `${PREVIEW_PROJECT_PREFIX}-${prNumber}`;
  const previewDir = join(tmpdir(), projectName);

  const { baseDomain } = await getInstanceConfig();

  // baseDomain is interpolated into YAML labels.
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(baseDomain)) {
    throw new Error(`Invalid baseDomain in instance config: ${baseDomain}`);
  }

  const domain = `vardo-pr-${prNumber}.${baseDomain}`;

  await _teardown(projectName).catch(() => {
    // Containers may not exist on first run.
  });

  await rm(previewDir, { recursive: true, force: true });
  await mkdir(previewDir, { recursive: true });

  log.info(`[self-preview] Cloning ${repoFullName}@${branch} into ${previewDir}`);
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--branch", branch, `https://github.com/${repoFullName}.git`, "."],
    { cwd: previewDir, timeout: 120_000 }
  );

  // Secrets go in a 0600 env file, not the compose YAML.
  const routerName = `vardo-pr-${prNumber}`;
  const envFileContent = buildEnvFile();
  const envFilePath = join(previewDir, ".preview.env");
  await writeFile(envFilePath, envFileContent, { encoding: "utf-8", mode: 0o600 });

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
      { env: dockerEnv(), cwd: previewDir, timeout: 600_000 }
    );
    if (stdout.trim()) log.info(`[self-preview] ${stdout.trim()}`);
    if (stderr.trim()) log.info(`[self-preview] ${stderr.trim()}`);
  } catch (err) {
    buildError = err instanceof Error ? err : new Error(String(err));
  } finally {
    // Containers have read it by now; don't leave credentials in /tmp.
    await rm(envFilePath, { force: true }).catch(() => {});
  }

  if (buildError) {
    throw new Error(`Vardo preview build failed for PR #${prNumber}: ${buildError.message}`);
  }

  return { domain, projectName };
}

/** Remove the preview containers, volumes and temp directory. */
export async function destroyVardoPreview(prNumber: number): Promise<void> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  const projectName = `${PREVIEW_PROJECT_PREFIX}-${prNumber}`;
  const previewDir = join(tmpdir(), projectName);

  log.info(`[self-preview] Destroying preview for PR #${prNumber}`);
  await _teardown(projectName);
  await rm(previewDir, { recursive: true, force: true });
}

/** Destroy self-previews older than maxAgeHours (catches missed PR-close webhooks). */
export async function cleanupStaleSelfPreviews(
  maxAgeHours = STALE_PREVIEW_MAX_AGE_HOURS
): Promise<number> {
  if (!(await isFeatureEnabledAsync("previews"))) return 0;

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "docker",
      [
        "ps",
        "--filter", `name=${PREVIEW_PROJECT_PREFIX}-`,
        "--format", "{{.Names}}\t{{.CreatedAt}}",
      ],
      { env: dockerEnv(), timeout: 30_000 }
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

    // e.g. vardo-preview-pr-42-vardo-1
    const match = containerName.match(/^vardo-preview-pr-(\d+)-/);
    if (!match) continue;

    const prNumber = parseInt(match[1], 10);
    if (isNaN(prNumber) || seen.has(prNumber)) continue;
    seen.add(prNumber);

    const createdMs = new Date(createdAt).getTime();
    if (isNaN(createdMs)) {
      log.warn(`[self-preview] Unparseable timestamp for container ${containerName}: ${createdAt}`);
      continue;
    }
    if (createdMs > cutoffMs) continue;

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

async function _teardown(projectName: string): Promise<void> {
  try {
    await execFileAsync(
      "docker",
      ["compose", "-p", projectName, "down", "--volumes"],
      { env: dockerEnv(), timeout: 60_000 }
    );
  } catch (err) {
    log.warn(
      `[self-preview] docker compose down failed (may already be stopped): ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Build .preview.env. Encryption and auth secrets are never passed through.
 * Security: without PREVIEW_DATABASE_URL this falls back to the production DATABASE_URL and exposes it to PR code.
 */
export function buildEnvFile(): string {
  const lines = [
    "VARDO_PREVIEW=true",
    "SKIP_MIGRATIONS=true",
  ];

  // Quoted so '#' in connection strings isn't read as a comment.
  const dbUrl = process.env.PREVIEW_DATABASE_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    const sanitized = dbUrl.replace(/\r?\n/g, " ");
    lines.push(`DATABASE_URL="${sanitized}"`);
  }

  const redisUrl = process.env.PREVIEW_REDIS_URL || process.env.REDIS_URL;
  if (redisUrl) {
    const sanitized = redisUrl.replace(/\r?\n/g, " ");
    lines.push(`REDIS_URL="${sanitized}"`);
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
    `      - "traefik.http.routers.${routerName}.tls.certresolver=le-dns"`,
    `      - "traefik.http.services.${routerName}.loadbalancer.server.port=3000"`,
    "    restart: unless-stopped",
    "networks:",
    `  ${VARDO_NETWORK}:`,
    "    external: true",
  ];

  return lines.join("\n") + "\n";
}
