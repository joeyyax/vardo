import { Loader2 } from "lucide-react";
import type { RunProgress } from "./types";

/** Live line for a run in flight: "Backing up immich (3 of 11)". */
export function RunProgressLine({
  progress,
  className = "",
}: {
  progress: RunProgress;
  className?: string;
}) {
  return (
    <span
      className={`flex items-center gap-1.5 text-xs text-status-warning ${className}`}
      aria-live="polite"
      title={`Volume: ${progress.volumeName}`}
    >
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      Backing up {progress.appName} ({progress.index} of {progress.total})
    </span>
  );
}
