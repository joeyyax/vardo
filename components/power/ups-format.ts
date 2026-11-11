// Labels and tones for UPS state, shared by the settings and status views.

import type { StatusDotTone } from "@/components/ui/status-dot";
import type { UpsHealth } from "@/lib/ups/status";
import type { UpsServerView } from "@/lib/ups/store";

export type { UpsServerView };

export const HEALTH_LABEL: Record<UpsHealth, string> = {
  online: "Online",
  "on-battery": "On battery",
  "low-battery": "Low battery",
  "lost-contact": "Lost contact",
  unknown: "Waiting for a reading",
};

export const HEALTH_TONE: Record<UpsHealth, StatusDotTone> = {
  online: "good",
  "on-battery": "issue",
  "low-battery": "issue",
  "lost-contact": "warn",
  unknown: "neutral",
};

/** Seconds as "24 min" or "1 h 5 min". */
export function formatRuntime(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export async function fetchUpsServers(): Promise<UpsServerView[] | null> {
  try {
    const res = await fetch("/api/v1/admin/ups");
    if (!res.ok) return null;
    return ((await res.json()).servers ?? []) as UpsServerView[];
  } catch {
    return null;
  }
}
