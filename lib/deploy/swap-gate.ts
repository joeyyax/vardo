// What a deploy checks before its swap touches containers: the exclusive section, then its claim.

import { isSelfApp } from "@/lib/docker/self-env";
import { DeployClosedElsewhereError } from "@/lib/docker/errors";
import type { DeployContext } from "@/lib/docker/deploy-context";
import { EXCLUSIVE_WAIT_MS, requestExclusive, runningExcept } from "./queue";

/** Vardo's own swap rotates the worker and console and can recreate the Postgres and Redis every deploy uses. */
export function needsExclusiveSwap(ctx: Pick<DeployContext, "app" | "envIsolated" | "claimedBy">): boolean {
  return !!ctx.claimedBy && isSelfApp(ctx.app.name) && !ctx.envIsolated;
}

function plural(n: number): string {
  return `${n} deploy${n === 1 ? "" : "s"}`;
}

/** Holds new claims and waits out running deploys when the swap needs it, then checks the claim. */
export async function beforeSwap(ctx: DeployContext, opts: { timeoutMs?: number; noticeMs?: number } = {}): Promise<void> {
  if (needsExclusiveSwap(ctx)) {
    const before = await runningExcept(ctx.deploymentId);
    ctx.log(
      before > 0
        ? `[deploy] Holding new deploys for the swap. Waiting for ${plural(before)} to finish`
        : "[deploy] Holding new deploys for the swap",
    );
    const { running, waitedMs } = await requestExclusive(ctx.deploymentId, {
      signal: ctx.signal,
      timeoutMs: opts.timeoutMs ?? EXCLUSIVE_WAIT_MS,
      noticeMs: opts.noticeMs,
      onWait: (n) => ctx.log(`[deploy] Waiting for ${plural(n)} to finish before the swap`),
    });
    if (running > 0) {
      ctx.log(
        `[deploy] Swapping with ${plural(running)} still running after ${Math.round(waitedMs / 60_000)} minutes. ` +
          "The old worker's drain finishes them, or they're requeued",
      );
    } else if (before > 0) {
      ctx.log(`[deploy] Other deploys finished after ${Math.round(waitedMs / 1000)}s`);
    }
  }
  if (ctx.fence && !(await ctx.fence())) throw new DeployClosedElsewhereError("this executor lost its claim");
}
