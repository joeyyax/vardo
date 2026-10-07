// QoS tier display. Critical apps auto-restart when unhealthy and need a memory limit.

import { ShieldCheck, Trash2, type LucideIcon } from "lucide-react";

export type AppPriority = "critical" | "standard" | "disposable";

export type PriorityMeta = {
  label: string;
  icon: LucideIcon;
  tone: string;
  title: string;
};

const META: Record<Exclude<AppPriority, "standard">, PriorityMeta> = {
  critical: {
    label: "Critical",
    icon: ShieldCheck,
    tone: "text-status-critical",
    title: "Critical priority — restarted automatically when unhealthy, and a memory limit is required",
  },
  disposable: {
    label: "Disposable",
    icon: Trash2,
    tone: "text-status-disposable",
    title: "Disposable priority — first to be shed when the host is under pressure",
  },
};

/** Null for the standard tier. */
export function priorityMeta(priority: string | null | undefined): PriorityMeta | null {
  if (priority === "critical" || priority === "disposable") return META[priority];
  return null;
}
