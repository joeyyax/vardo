"use client";

import type { ReactNode } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";

import { conditionHref, conditionTitle } from "@/lib/ui/conditions";
import { Term } from "@/components/term";
import { conditionTerm } from "@/lib/ui/glossary";
import { TabLink } from "@/components/tab-link";
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
export function AppConditionsPanel({
  conditions,
  appName,
  onNavigate,
}: {
  conditions: AppCondition[] | null;
  /** With onNavigate, each condition links to the tab that explains it. */
  appName?: string;
  onNavigate?: (tab: string) => void;
}) {
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
            {appName && onNavigate ? (
              <ConditionLink href={conditionHref(appName, c.kind)} onNavigate={onNavigate} className={`shrink-0 font-medium ${TONE[c.severity].text}`}>
                <Term id={conditionTerm(c)} passive>
                  {conditionTitle(c)}
                </Term>
              </ConditionLink>
            ) : (
              <span className={`shrink-0 font-medium ${TONE[c.severity].text}`}>
                <Term id={conditionTerm(c)}>{conditionTitle(c)}</Term>
              </span>
            )}
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

/** A condition's title, linked to its tab; a plain click switches tabs in place. */
function ConditionLink({
  href,
  onNavigate,
  className,
  children,
}: {
  href: string;
  onNavigate: (tab: string) => void;
  className: string;
  children: ReactNode;
}) {
  const tab = href.split("/").pop() ?? "";
  return (
    <TabLink href={href} onSwitch={() => onNavigate(tab)} className={className}>
      {children}
    </TabLink>
  );
}
