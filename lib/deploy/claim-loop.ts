// deploy-claim: each pass claims queued deploys and group jobs up to free capacity and starts them without waiting.

import { logger } from "@/lib/logger";
import { IntervalLoop, type LoopRole } from "@/lib/worker/interval-loop";
import { claimScope, type ClaimScope } from "./claim-scope";
import { executorId, isDraining, startClaimed } from "./executor";
import { GROUP_JOBS_PER_EXECUTOR, claimGroupJobs, groupJobsHere, startGroupJob } from "./group-job";
import { claimDeploys, clearFinishedExclusive, type ClaimOpts, type TargetSlots } from "./queue";
import { markQueuedForOldSweeper } from "./legacy-compat";
import { clearFinishedWaits, endQueueWaits, markQueueWaits } from "./waiting";
import { readPowerGate } from "@/lib/power/gate";

const log = logger.child("deploy-claim");

export const CLAIM_INTERVAL_MS = 1_000;

const SELF_FILTER: Record<Exclude<ClaimScope, "none">, ClaimOpts["self"]> = { all: undefined, self: "only", others: "exclude" };

const DESCRIBE: Record<ClaimScope, string> = {
  all: "every deploy",
  self: "Vardo's own deploys",
  others: "every deploy but Vardo's own",
  none: "no deploys (VARDO_DEPLOY_EXECUTOR=web)",
};

/** Build target slots for this pass. Only a claimer that may start other apps' deploys checks targets itself. */
async function targetSlots(scope: ClaimScope): Promise<TargetSlots | null> {
  try {
    const { targetSlotView } = await import("@/lib/docker/build-gate");
    return await targetSlotView({ probe: scope === "all" || scope === "others" });
  } catch (err) {
    log.warn("Couldn't read build target slots; counting this server's only:", err);
    return null;
  }
}

/** One pass: clears finished exclusive flags, claims and starts, then records why the rest still wait. Returns the ids started. */
export async function claimPass(scope: ClaimScope): Promise<string[]> {
  await markQueuedForOldSweeper();
  const targets = await targetSlots(scope);
  const power = await readPowerGate();
  try {
    return await claimAndStart(scope, targets, power.holdDeploys);
  } finally {
    // Runs even with nothing to claim, so a missing worker still shows.
    await markQueueWaits({ targets, powerHold: power.holdDeploys })
      .then(async (written) => {
        const held = written.filter((w) => w.wait_reason === "power").map((w) => w.id);
        if (held.length === 0) return;
        const { recordDeploysHeld } = await import("@/lib/power/deploys");
        await recordDeploysHeld(held, power.outage);
      })
      .catch((err) => log.warn("Couldn't record why queued deploys wait:", err));
    await clearFinishedWaits().catch(() => {});
  }
}

async function claimAndStart(scope: ClaimScope, targets: TargetSlots | null, powerHold: boolean): Promise<string[]> {
  if (scope === "none" || isDraining()) return [];
  const me = executorId();
  const started: string[] = [];

  const { ownSlot } = await import("@/lib/docker/own-slot");
  await clearFinishedExclusive(await ownSlot());

  const claimed = await claimDeploys(me, { self: SELF_FILTER[scope], targets, powerHold });
  await endQueueWaits(claimed.filter((row) => row.waited).map((row) => row.id));
  for (const row of claimed) {
    log.info(`Claimed deployment ${row.id} (${row.trigger}, ${row.scopeKey}${row.onTarget ? ", on a build target's slot" : ""})`);
    void startClaimed(row);
    started.push(row.id);
  }

  if (scope !== "self") {
    for (const job of await claimGroupJobs(me, GROUP_JOBS_PER_EXECUTOR - groupJobsHere().length)) {
      log.info(`Claimed group deploy ${job.id}`);
      void startGroupJob(job, me);
      started.push(job.id);
    }
  }
  return started;
}

function claimLoop(name: string, role: LoopRole): IntervalLoop<string[]> {
  let scope: ClaimScope = "none";
  return new IntervalLoop({
    name,
    intervalMs: CLAIM_INTERVAL_MS,
    log,
    prepare: async () => {
      scope = claimScope(role);
      log.info(`Claiming ${DESCRIBE[scope]}`);
    },
    run: () => claimPass(scope),
  });
}

/** The worker's claimer. */
export const deployClaimLoop = claimLoop("deploy-claim", "worker");

/** The console's claimer: Vardo's own deploys, or every deploy with VARDO_DEPLOY_EXECUTOR=web or an embedded worker. */
export const webDeployClaimLoop = claimLoop("deploy-claim-web", "web");
