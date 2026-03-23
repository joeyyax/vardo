import { Cloud, Server } from "lucide-react";
import type { BackupTarget } from "./types";

export const SCHEDULE_PRESETS = [
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at 2 AM", value: "0 2 * * *" },
  { label: "Weekly (Sunday 2 AM)", value: "0 2 * * 0" },
  { label: "Manual only", value: "manual" },
] as const;

export function scheduleLabel(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label;
  return cron;
}

export function targetSubtitle(target: BackupTarget): string {
  const config = target.config as Record<string, string>;
  switch (target.type) {
    case "s3":
    case "r2":
    case "b2":
      return config.endpoint || config.region || "";
    case "ssh":
      return `${config.username || "root"}@${config.host}:${config.path || "/"}`;
    default:
      return target.type;
  }
}

export function TargetIcon({ type }: { type: string }) {
  switch (type) {
    case "s3":
    case "r2":
    case "b2":
      return <Cloud className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />;
    case "ssh":
      return <Server className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />;
    default:
      return <Server className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />;
  }
}
