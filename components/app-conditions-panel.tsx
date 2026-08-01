import { AlertTriangle, ShieldAlert } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { conditionLabel } from "@/lib/ui/conditions";
import { worstCondition, type AppCondition, type ConditionSeverity } from "@/lib/docker/conditions";

const TONE: Record<ConditionSeverity, { border: string; surface: string; text: string }> = {
  critical: {
    border: "border-status-error/40",
    surface: "bg-status-error-muted/40",
    text: "text-status-error",
  },
  warning: {
    border: "border-status-warning/40",
    surface: "bg-status-warning-muted/40",
    text: "text-status-warning",
  },
  info: {
    border: "border-border",
    surface: "bg-muted/40",
    text: "text-muted-foreground",
  },
};

/**
 * What needs a human on this app, above the fold. Renders nothing when the app
 * is behaving — a permanent "all clear" trains people to stop reading it.
 */
export function AppConditionsPanel({ conditions }: { conditions: AppCondition[] | null }) {
  const list = conditions ?? [];
  if (list.length === 0) return null;

  const worst = worstCondition(list)!;
  const tone = TONE[worst.severity];
  const Icon = worst.severity === "critical" ? ShieldAlert : AlertTriangle;

  return (
    <div className={`squircle rounded-lg border ${tone.border} ${tone.surface} p-3 text-sm`}>
      <div className="flex items-center gap-2">
        <Icon className={`size-4 shrink-0 ${tone.text}`} />
        <span className="font-medium">
          {list.length === 1 ? "This app needs attention" : `${list.length} things need attention`}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {list.map((c) => (
          <li key={c.kind} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`font-medium ${TONE[c.severity].text}`}>{conditionLabel(c)}</span>
            <span className="text-muted-foreground">{c.detail}</span>
            <span className="text-xs text-muted-foreground/70">
              for {formatDistanceToNowStrict(new Date(c.since))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
