"use client";

import { AlertTriangle } from "lucide-react";
import { isUncapturedSource } from "@/lib/backups/coverage";
import type { App } from "./types";

/** Volume sources on these apps that the engine cannot capture, labeled per app. */
export function uncapturedSources(apps: App[]): string[] {
  return apps.flatMap((app) =>
    (app.volumes ?? [])
      .filter(isUncapturedSource)
      .map((vol) => `${app.displayName}: ${vol.source || vol.name}`),
  );
}

export function UncapturedWarning({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;

  return (
    <p className="flex items-start gap-1.5 text-xs text-status-warning">
      <AlertTriangle className="size-3.5 shrink-0 mt-px" aria-hidden="true" />
      <span>Not backed up — bind mounts must be copied from the host: {sources.join(", ")}</span>
    </p>
  );
}
