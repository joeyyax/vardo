// What the status chip by the branding reads on the server.

import { deploysWaitingForWorker, workerMissing } from "@/lib/deploy/waiting";
import { readWorkers, summarizeWorkers } from "@/lib/worker/presence";
import type { WorkerOutage } from "@/lib/ui/system-status";

/** The missing worker, its last beat and the deploys queued behind it. Null while one runs. Admins also get the instance total. */
export async function workerOutage(organizationId: string, instanceAdmin: boolean): Promise<WorkerOutage | null> {
  try {
    if (!(await workerMissing())) return null;
    const [{ now, rows }, queued, queuedInstance] = await Promise.all([
      readWorkers(),
      deploysWaitingForWorker(organizationId),
      instanceAdmin ? deploysWaitingForWorker() : null,
    ]);
    const { workerAt } = summarizeWorkers(rows, now);
    return { since: workerAt?.toISOString() ?? null, queued, queuedInstance };
  } catch {
    return null;
  }
}

/** "Vardo 0.1.0 (058ad90)". */
export function versionLabel(): string {
  const sha = process.env.NEXT_PUBLIC_GIT_SHA?.slice(0, 7);
  return `Vardo ${process.env.npm_package_version || "0.1.0"}${sha ? ` (${sha})` : ""}`;
}
