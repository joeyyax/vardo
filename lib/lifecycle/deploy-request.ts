// Host-side redeploys of Vardo itself. `vardo update` drops a request file in the lifecycle dir; a console claims it.
// Nothing listens on the network: only root or the console's own user can write the directory.

import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import { logger } from "@/lib/logger";
import { LIFECYCLE_DIR } from "@/lib/paths";
import { closeOnShutdown } from "@/lib/shutdown";

const log = logger.child("deploy-request");

export const REQUEST_FILE = "deploy-request.json";
export const RESULT_FILE = "deploy-request.result.json";
/** Rewritten every poll; install.sh reads its `at` to tell a listening console from an old one. */
export const READY_FILE = "deploy-requests.ready";

const REQUEST_POLL_MS = 5_000;

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type DeployRequest = { id: string };

export type DeployRequestResult =
  | { id: string; state: "accepted"; deploymentId: string; at: number }
  | { id: string; state: "refused"; error: string; at: number };

export function parseDeployRequest(text: string): DeployRequest | null {
  try {
    const raw = JSON.parse(text) as { id?: unknown };
    return typeof raw.id === "string" && ID_RE.test(raw.id) ? { id: raw.id } : null;
  } catch {
    return null;
  }
}

/** Queues a deploy of the `vardo` app and returns its id without waiting for it. */
export async function triggerSelfDeploy(opts: { triggeredBy?: string; gitSha?: string } = {}): Promise<{ deploymentId: string }> {
  // Registers the app on installs that haven't yet: a fresh install's first handover.
  const { ensureVardoProject } = await import("@/lib/docker/self-register");
  await ensureVardoProject({ force: true });

  const app = await db.query.apps.findFirst({
    where: and(eq(apps.name, VARDO_SELF_APP_NAME), isNull(apps.parentAppId), eq(apps.isSystemManaged, true)),
    columns: { id: true, organizationId: true },
  });
  if (!app) throw new Error(`No system-managed "${VARDO_SELF_APP_NAME}" app to deploy`);

  const { createDeployment } = await import("@/lib/docker/deploy");
  const { requestDeploy } = await import("@/lib/docker/deploy-cancel");
  const deployOpts = { appId: app.id, organizationId: app.organizationId, trigger: "api" as const, triggeredBy: opts.triggeredBy };
  const deploymentId = await createDeployment(deployOpts);
  void requestDeploy({ ...deployOpts, deploymentId, gitSha: opts.gitSha }).catch((err) => log.error(`Deploy ${deploymentId} failed to run:`, err));
  return { deploymentId };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o644 });
  await rename(tmp, file);
}

/** Claims and runs a pending request. Returns its result, or null when there was none to claim. */
export async function processDeployRequest(
  dir = LIFECYCLE_DIR,
  trigger: () => Promise<{ deploymentId: string }> = triggerSelfDeploy,
): Promise<DeployRequestResult | null> {
  const claimed = join(dir, `${REQUEST_FILE}.${process.pid}.claimed`);
  try {
    // Rename is atomic: with two consoles up mid-deploy, one claims it.
    await rename(join(dir, REQUEST_FILE), claimed);
  } catch {
    return null;
  }

  let result: DeployRequestResult;
  const request = parseDeployRequest(await readFile(claimed, "utf-8").catch(() => ""));
  if (!request) {
    result = { id: "invalid", state: "refused", error: "Unreadable deploy request", at: Date.now() };
  } else {
    try {
      const { deploymentId } = await trigger();
      result = { id: request.id, state: "accepted", deploymentId, at: Date.now() };
      log.info(`Request ${request.id}: deploying Vardo as ${deploymentId}`);
    } catch (err) {
      result = { id: request.id, state: "refused", error: err instanceof Error ? err.message : String(err), at: Date.now() };
      log.warn(`Request ${request.id} refused: ${result.error}`);
    }
  }
  await writeJson(join(dir, RESULT_FILE), result);
  await rm(claimed, { force: true });
  return result;
}

async function tick(): Promise<void> {
  await mkdir(LIFECYCLE_DIR, { recursive: true }).catch(() => {});
  await writeJson(join(LIFECYCLE_DIR, READY_FILE), { at: Math.floor(Date.now() / 1000) }).catch(() => {});
  await processDeployRequest();
}

const globalForRequests = globalThis as unknown as { __vardo_deploy_requests?: boolean };

/** Polls for requests from `vardo update`. */
export function startDeployRequestWatcher(): void {
  if (globalForRequests.__vardo_deploy_requests) return;
  globalForRequests.__vardo_deploy_requests = true;

  let running = false;
  const interval = setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err) => log.warn("Deploy request check failed:", err))
      .finally(() => {
        running = false;
      });
  }, REQUEST_POLL_MS);
  interval.unref();

  closeOnShutdown(async () => {
    clearInterval(interval);
    await rm(join(LIFECYCLE_DIR, READY_FILE), { force: true }).catch(() => {});
  });
}
