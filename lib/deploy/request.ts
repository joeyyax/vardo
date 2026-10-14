// Deploys a caller waits on: enqueue, follow the stream when asked, return the finished row.

import { tailDeployment, tailed, type TailHandlers, type TailedDeployment } from "@/lib/stream/deploy-tail";
import { awaitDeployment, enqueueDeploy, type EnqueueOpts } from "./queue";

export type WaitOpts = Partial<TailHandlers> & { signal?: AbortSignal };

/** Waits for a queued deployment to finish, following its stream when handlers are given. */
export async function waitForDeployment(id: string, opts: WaitOpts = {}): Promise<TailedDeployment> {
  if (opts.onLog || opts.onStage || opts.onWaiting) {
    const result = await tailDeployment(
      id,
      { onLog: opts.onLog ?? (() => {}), onStage: opts.onStage ?? (() => {}), onWaiting: opts.onWaiting },
      { signal: opts.signal },
    );
    if (result) return result;
  }
  const row = await awaitDeployment(id, { signal: opts.signal });
  return tailed(id, row);
}

/** Enqueues a deploy and waits for it to finish. */
export async function deployAndWait(opts: EnqueueOpts, wait: WaitOpts = {}): Promise<TailedDeployment> {
  const { id } = await enqueueDeploy(opts);
  return waitForDeployment(id, wait);
}
