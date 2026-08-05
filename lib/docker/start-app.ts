// ---------------------------------------------------------------------------
// Start / restart an app, shared by the HTTP route and the MCP tool.
//
// `stopProject` runs `compose down`, which removes the containers, so a running
// app and a stopped one need different compose commands. Both callers come
// through here so the two cannot drift apart again.
// ---------------------------------------------------------------------------

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

/**
 * Bring the deployed slot back up without rebuilding it.
 *
 * `--no-recreate` leaves anything already running alone, so starting one
 * service of a half-up stack touches only what is down.
 */
async function upActiveSlot(
  appName: string,
  envName: string,
  service?: string,
): Promise<{ success: boolean; log: string; failure?: StartFailure }> {
  const logs: string[] = [];
  try {
    const dir = appEnvDir(appName, envName);
    const { slotDir, composeProject } = await resolveActiveSlot(dir, `${appName}-${envName}`);

    // Nothing was ever written here, so there is nothing to bring up.
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
        { cwd: slotDir, timeout: COMPOSE_UP_TIMEOUT },
      );
      if (stdout.trim()) logs.push(stdout.trim());
      if (stderr.trim()) logs.push(stderr.trim());
    };

    if (service) {
      // A shared service runs in its own project; the slot project's `up` would
      // start a second copy of it.
      const shared = partition !== null && service in partition.shared;
      await up(
        shared ? sharedProjectName(appName, envName) : composeProject,
        shared ? ["--no-deps", service] : [service],
      );
    } else if (partition) {
      // The same split the deploy made. Shared first, so a database is
      // answering before anything that depends on it comes up.
      await up(sharedProjectName(appName, envName), sharedScopeArgs(partition));
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
 * Restart a running app in place, or bring a stopped one back up from the slot
 * already on disk. Records the lifecycle row for whichever it turned out to be.
 *
 * `compose restart` exits 0 against a project whose containers were removed and
 * starts nothing, so a stopped app must be brought up instead.
 */
export async function startOrRestartApp(opts: {
  organizationId: string;
  app: StartApp;
  userId?: string;
  trigger?: LifecycleTrigger;
}): Promise<StartResult> {
  const { app, organizationId } = opts;

  // A compose child has no project of its own — the parent owns it, and the
  // child is one service inside it.
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

  // Slot directories and compose projects are environment-scoped; without the
  // name this resolves to the legacy layout and finds nothing.
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

  // Asking for it to run is the opposite of shelving it. Cleared on the owner,
  // so restarting one service unparks the stack it belongs to.
  await setParked(ownerId, false);

  // The containers are new; the row still describes the ones they replaced.
  const observed = await reconcileAppNow(app.id);

  // Compose can exit clean having brought nothing up, so a start only counts
  // once Docker agrees it is running.
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
