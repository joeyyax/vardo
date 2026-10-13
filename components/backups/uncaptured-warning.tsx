"use client";

import { AlertTriangle } from "lucide-react";
import { isUncapturedSource } from "@/lib/backups/coverage";
import { isBackupSelected, type Durability } from "@/lib/backups/durability";
import type { App, AppVolume } from "./types";

export type UncapturedSources = { binds: string[]; config: string[] };

const selected = (vol: AppVolume) =>
  isBackupSelected({
    persistent: vol.persistent ?? true,
    durability: (vol.durability ?? null) as Durability | null,
    backupSelection: vol.backupSelection,
  });

/** Volume sources on these apps that the engine leaves out, labeled per app. */
export function uncapturedSources(apps: App[]): UncapturedSources {
  const out: UncapturedSources = { binds: [], config: [] };
  for (const app of apps) {
    for (const vol of app.volumes ?? []) {
      const label = `${app.displayName}: ${vol.source || vol.name}`;
      if (isUncapturedSource(vol)) out.binds.push(label);
      else if (vol.configReason && selected(vol)) out.config.push(`${label} (${vol.configReason.toLowerCase()})`);
    }
  }
  return out;
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-status-warning">
      <AlertTriangle className="size-3.5 shrink-0 mt-px" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function UncapturedWarning({ sources }: { sources: UncapturedSources }) {
  if (sources.binds.length === 0 && sources.config.length === 0) return null;

  return (
    <>
      {sources.binds.length > 0 && (
        <Line>Not backed up — bind mounts must be copied from the host: {sources.binds.join(", ")}</Line>
      )}
      {sources.config.length > 0 && (
        <Line>Not backed up — app config the engine leaves out: {sources.config.join(", ")}</Line>
      )}
    </>
  );
}
