// deploy-claim: each pass claims queued deploys and group jobs up to free capacity and starts them without waiting.

import { logger } from "@/lib/logger";
import { IntervalLoop, type LoopRole } from "@/lib/worker/interval-loop";
import { claimScope, type ClaimScope } from "./claim-scope";
import { executorId, isDraining, startClaimed } from "./executor";
import { GROUP_JOBS_PER_EXECUTOR, claimGroupJobs, groupJobsHere, startGroupJob } from "./group-job";
import { claimDeploys, clearFinishedExclusive, type ClaimOpts } from "./queue";
import { markQueuedForOldSweeper } from "./legacy-compat";

const log = logger.child("deploy-claim");

export const CLAIM_INTERVAL_MS = 1_000;

const SELF_FILTER: Record<Exclude<ClaimScope, "none">, ClaimOpts["self"]> = { all: undefined, self: "only", others: "exclude" };

const DESCRIBE: Record<ClaimScope, string> = {
  all: "every deploy",
  self: "Vardo's own deploys",
  others: "every deploy but Vardo's own",
  none: "no deploys (VARDO_DEPLOY_EXECUTOR=web)",
};

/** One pass: clears finished exclusive flags, then claims and starts. Returns the ids started. */
export async function claimPass(scope: ClaimScope): Promise<string[]> {
  await markQueuedForOldSweeper();
  if (scope === "none" || isDraining()) return [];
  const me = executorId();
  const started: string[] = [];

  const { ownSlot } = await import("@/lib/docker/own-slot");
  await clearFinishedExclusive(await ownSlot());

  for (const row of await claimDeploys(me, { self: SELF_FILTER[scope] })) {
    log.info(`Claimed deployment ${row.id} (${row.trigger}, ${row.scopeKey})`);
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
