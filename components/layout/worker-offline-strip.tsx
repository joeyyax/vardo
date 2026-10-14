import { Clock } from "lucide-react";
import { deploysWaitingForWorker } from "@/lib/deploy/waiting";

/** Under the nav while deploys queue for a worker that isn't running. */
export async function WorkerOfflineStrip() {
  const waiting = await deploysWaitingForWorker().catch(() => 0);
  if (waiting === 0) return null;
  return (
    <div className="border-b bg-card text-sm" role="status" data-testid="worker-offline">
      <div className="container flex h-9 min-w-0 items-center gap-2.5">
        <Clock aria-hidden="true" className="size-4 shrink-0 text-status-warning" />
        <span className="truncate">
          Worker offline. {waiting} {waiting === 1 ? "deploy" : "deploys"} queued.
        </span>
      </div>
    </div>
  );
}
