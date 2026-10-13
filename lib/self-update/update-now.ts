import { spawn } from "child_process";
import { join } from "path";
import { logger } from "@/lib/logger";
import { isSelfDeployLayout, VARDO_HOME_DIR } from "@/lib/paths";
import { getChannelUpdate } from "@/lib/version";
import { effectiveChannel } from "./policy";
import { startUpdate } from "./runner";
import { getUpdatePolicy } from "./store";

const log = logger.child("admin:maintenance:update");

export type UpdateNowResult = { ok: true; deploymentId?: string; message: string };

/**
 * Update now: dumps the database and redeploys the `vardo` app on the policy's channel, then verifies it.
 * A legacy install runs install.sh update. Throws UpdateBlockedError when an update can't start.
 */
export async function updateNow(triggeredBy: string): Promise<UpdateNowResult> {
  if (isSelfDeployLayout()) {
    const channel = effectiveChannel(await getUpdatePolicy());
    const run = await startUpdate({
      trigger: "manual",
      triggeredBy,
      channel,
      update: await getChannelUpdate(channel),
    });
    log.info(`redeploying Vardo as ${run.deploymentId}`);
    return { ok: true, deploymentId: run.deploymentId, message: `Updating Vardo to ${run.toLabel}.` };
  }

  const installScript = join(VARDO_HOME_DIR, "install.sh");

  log.info("triggering install.sh update in background");

  setTimeout(() => {
    const update = spawn("bash", [installScript, "update", "--yes"], {
      detached: true,
      stdio: "ignore",
      cwd: VARDO_HOME_DIR,
    });
    update.unref();
  }, 500);

  return { ok: true, message: "Update initiated — blue/green deploy running in the background." };
}
