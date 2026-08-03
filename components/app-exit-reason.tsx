import { Skull } from "lucide-react";

import type { ExitReason } from "@/lib/docker/exit-reason";
import { exitReasonDetail, exitReasonLabel, exitReasonTone } from "@/lib/ui/exit-reason";
import { formatRelativeTime } from "@/lib/ui/relative-time";

/** The detail ends in an exit code, so the stamp needs a separator ahead of it. */
export function exitReasonSentence(reason: ExitReason, now?: Date): string {
  return `${exitReasonDetail(reason)}, ${formatRelativeTime(reason.at, now)}.`;
}

/**
 * Why the app's containers are down. An OOM kill reads as an incident; an
 * ordinary stop stays a quiet line, because most 137s are a stop that outran
 * its grace period and nothing is wrong with them.
 */
export function AppExitReason({
  reason,
  status,
}: {
  reason: ExitReason | null;
  status: string;
}) {
  if (!reason) return null;
  if (status === "active" || status === "deploying") return null;

  if (exitReasonTone(reason.kind) === "muted") {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{exitReasonLabel(reason.kind)}</span>{" "}
        {exitReasonSentence(reason)}
      </p>
    );
  }

  return (
    <div className="squircle rounded-lg border border-status-error/40 bg-status-error-muted/40 p-3 text-sm">
      <div className="flex items-center gap-2">
        <Skull className="size-4 shrink-0 text-status-error" />
        <span className="font-medium text-status-error">{exitReasonLabel(reason.kind)}</span>
      </div>
      <p className="mt-1.5 text-muted-foreground">
        {exitReasonSentence(reason)}{" "}
        {reason.kind === "oom-host"
          ? "The host is short on memory — free some up, or give this app a limit so it is not the kernel's choice next time."
          : "Raise this app's memory limit, or find out what is using more than it was given."}
      </p>
    </div>
  );
}
