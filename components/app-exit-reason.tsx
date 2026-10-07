import { Skull } from "lucide-react";

import type { ExitReason } from "@/lib/docker/exit-reason";
import { exitReasonDetail, exitReasonLabel, exitReasonTone } from "@/lib/ui/exit-reason";
import { formatRelativeTime } from "@/lib/ui/relative-time";

/** The exit reason and when it happened, as one sentence. */
export function exitReasonSentence(reason: ExitReason, now?: Date): string {
  return `${exitReasonDetail(reason)}, ${formatRelativeTime(reason.at, now)}.`;
}

/** Why the app's containers are down. Only an OOM kill reads as an incident. */
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
    <div className="squircle rounded-lg bg-status-error-muted p-4 text-sm border border-status-error-edge">
      <div className="flex items-center gap-2">
        <Skull className="size-4 shrink-0 text-status-error" />
        <span className="font-medium text-status-error">{exitReasonLabel(reason.kind)}</span>
      </div>
      <p className="mt-1.5 text-muted-foreground">
        {exitReasonSentence(reason)}{" "}
        {reason.kind === "oom-host"
          ? "The host is short on memory — free some up, or give this app a limit so it isn't the kernel's choice next time."
          : "Raise this app's memory limit, or find out what is using more than it was given."}
      </p>
    </div>
  );
}
