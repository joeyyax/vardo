import { AlertTriangle, ShieldAlert } from "lucide-react";

import { conditionTitle } from "@/lib/ui/conditions";
import { formatSpan } from "@/lib/ui/relative-time";
import { worstCondition, type AppCondition, type ConditionSeverity } from "@/lib/docker/conditions";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const TONE: Record<ConditionSeverity, { border: string; surface: string; text: string }> = {
  critical: {
    border: "border-status-error-edge",
    surface: "bg-status-error-muted",
    text: "text-status-error",
  },
  warning: {
    border: "border-status-warning-edge",
    surface: "bg-status-warning-muted",
    text: "text-status-warning",
  },
  info: {
    border: "dark:border",
    surface: "bg-muted",
    text: "text-muted-foreground",
  },
};

/** What needs a human on this app. Renders nothing when the app is healthy. */
export function AppConditionsPanel({ conditions }: { conditions: AppCondition[] | null }) {
  const list = conditions ?? [];
  if (list.length === 0) return null;

  const worst = worstCondition(list)!;
  const tone = TONE[worst.severity];
  const Icon = worst.severity === "critical" ? ShieldAlert : AlertTriangle;

  return (
    <Card variant="plain" className={cn("border p-3 text-sm", tone.border, tone.surface)}>
      <div className="flex items-center gap-2">
        <Icon className={`size-4 shrink-0 ${tone.text}`} />
        <span className="font-medium">
          {list.length === 1 ? "This app needs attention" : `${list.length} things need attention`}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {list.map((c) => (
          <li key={c.kind} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`shrink-0 font-medium ${TONE[c.severity].text}`}>
              {conditionTitle(c)}
            </span>
            <span className="text-muted-foreground">{c.detail}</span>
            <span className="text-xs text-muted-foreground/70">
              for {formatSpan(c.since)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
