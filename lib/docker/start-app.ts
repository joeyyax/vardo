// Start or restart an app, shared by the HTTP route and the MCP tool.

import { access } from "fs/promises";
import { and, eq } from "drizzle-orm";
import { execFileAsync } from "@/lib/utils/exec";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { setParked } from "@/lib/db/app-parked";
import { appEnvDir } from "@/lib/paths";
import { recordLifecycle } from "@/lib/activity/lifecycle";
import type { LifecycleTrigger } from "@/lib/ui/lifecycle";

import { resolveActiveSlot } from "./active-slot";
import { slotComposeFiles } from "./compose";
import { COMPOSE_UP_TIMEOUT } from "./constants";
import { restartContainers } from "./deploy";
import { resolveDefaultEnv } from "./resolve-env";
import { readSlotPartition, sharedScopeArgs } from "./shared-project";
import { sharedProjectName, slotScopeArgs } from "./slot-partition";
import { reconcileAppNow, type ObservedStatus } from "./status-reconcile";
import { dockerEnv } from "@/lib/docker/docker-env";

export type StartAction = "restarted" | "started" | "none";

/** Why nothing happened. `no-slot` is the only one a deploy would fix. */
export type StartFailure = "no-parent" | "no-slot" | "compose";

export type StartApp = {
  id: string;
  name: string;
  status: string;
  parentAppId: string | null;
  composeService: string | null;
  /** Recorded on the lifecycle row: neither command applies pending config. */
  needsRedeploy?: boolean | null;
};

export type StartResult = {
  success: boolean;
  log: string;
  action: StartAction;
  failure?: StartFailure;
  /** What Docker reported once the command returned. */
  observed?: ObservedStatus | null;
};

/** An app with no containers is started; one that still has them is restarted. */
function wasOff(status: string): boolean {
  return status === "stopped" || status === "missing";
}

/** Bring the deployed slot back up without rebuilding; `--no-recreate` leaves running services alone. */
async function upActiveSlot(
  appName: string,
  envName: string,
  service?: string,
): Promise<{ success: boolean; log: string; failure?: StartFailure }> {
  const logs: string[] = [];
  try {
    const dir = appEnvDir(appName, envName);
    const { slotDir, composeProject } = await resolveActiveSlot(dir, `${appName}-${envName}`);

    try {
      await access(slotDir);
    } catch {
      return {
        success: false,
        failure: "no-slot",
        log: `No deployed compose project found for ${appName} (missing ${slotDir}). Deploy the app to bring it up.`,
      };
    }

    const composeFileArgs = await slotComposeFiles(slotDir);
    const partition = await readSlotPartition(slotDir);

    const up = async (project: string, scope: string[]) => {
      const { stdout, stderr } = await execFileAsync(
        "docker",
        [
          "compose",
          ...composeFileArgs,
          "-p", project,
          "up", "-d",
          "--no-recreate",
          "--pull", "never",
          ...scope,
        ],
        { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_UP_TIMEOUT },
      );
      if (stdout.trim()) logs.push(stdout.trim());
      if (stderr.trim()) logs.push(stderr.trim());
    };

    if (service) {
      // Shared services run in their own project; the slot project would start a second copy.
      const shared = partition !== null && service in partition.shared;
      await up(
        shared ? sharedProjectName(appName, envName, partition.composeName) : composeProject,
        shared ? ["--no-deps", service] : [service],
      );
    } else if (partition) {
      // Shared first, so databases are up before their dependents.
      await up(sharedProjectName(appName, envName, partition.composeName), sharedScopeArgs(partition));
      await up(composeProject, slotScopeArgs(partition));
    } else {
      await up(composeProject, []);
    }

    return { success: true, log: logs.join("\n") };
  } catch (err) {
    logs.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, failure: "compose", log: logs.join("\n") };
  }
}

/**
 * Restart a running app in place, or bring a stopped one up from its slot, and record the lifecycle row.
 * `compose restart` exits 0 and starts nothing once `compose down` removed the containers.
 */
export async function startOrRestartApp(opts: {
  organizationId: string;
  app: StartApp;
  userId?: string;
  trigger?: LifecycleTrigger;
}): Promise<StartResult> {
  const { app, organizationId } = opts;

  // A compose child is one service in its parent's project.
  let ownerId = app.id;
  let project = app.name;
  let service: string | undefined;
  if (app.parentAppId) {
    const parent = await db.query.apps.findFirst({
      where: and(eq(apps.id, app.parentAppId), eq(apps.organizationId, organizationId)),
      columns: { id: true, name: true },
    });
    if (!parent || !app.composeService) {
      return {
        success: false,
        action: "none",
        failure: "no-parent",
        log: "Could not resolve the parent compose project for this service",
      };
    }
    ownerId = parent.id;
    project = parent.name;
    service = app.composeService;
  }

  // Slot directories and compose projects are environment-scoped.
  const env = await resolveDefaultEnv(ownerId);

  const off = wasOff(app.status);
  const startedAt = Date.now();
  const result = off
    ? await upActiveSlot(project, env.name, service)
    : {
        ...(await restartContainers(project, env.name, service)),
        failure: "compose" as StartFailure,
      };
  const durationMs = Date.now() - startedAt;

  if (!result.success) {
    return { success: false, action: "none", failure: result.failure, log: result.log };
  }

  // Clears the operator stop on the owner; restarting one service clears its stack.
  await setParked(ownerId, false);

  // Refresh the row for the new containers.
  const observed = await reconcileAppNow(app.id);

  // Compose can exit clean having started nothing; a start counts only once Docker reports it running.
  if (off && observed !== null && observed !== "active") {
    return {
      success: false,
      action: "none",
      failure: "compose",
      observed,
      log: result.log || `${app.name} did not come up (now ${observed}).`,
    };
  }

  await recordLifecycle({
    organizationId,
    app,
    kind: off ? "started" : "restarted",
    userId: opts.userId,
    trigger: opts.trigger,
    status: observed,
    durationMs,
  });

  return {
    success: true,
    action: off ? "started" : "restarted",
    observed,
    log: result.log,
  };
}
