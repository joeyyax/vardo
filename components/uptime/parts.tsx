"use client";

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { quietLinkClass } from "@/components/entity-link";
import { Chip } from "@/components/ui/chip";
import { StatusMark } from "@/components/ui/status-dot";
import { stateLabel, tickTitle, tickTone, type TickTone } from "@/lib/uptime/format";
import { rangeSlots } from "@/lib/uptime/core/range";
import type { DayTick, DisplayState, MonitorSummary, UptimeRange } from "@/lib/uptime/types";
import { cn } from "@/lib/utils";
import { useUptimeTimeZone } from "./time-zone";

const TICK_COLOR: Record<TickTone, string> = {
  up: "bg-status-success",
  partial: "bg-status-warning",
  down: "bg-status-error",
  none: "bg-muted",
};

/** One bar per day: green up, amber partial, red down, grey no data. */
export function DayTicks({ days, className, tall = false, barMs, range }: { days: DayTick[]; className?: string; tall?: boolean; barMs?: number; range?: UptimeRange }) {
  const timeZone = useUptimeTimeZone();
  // Bars keep the width they have with full history and sit against "now"; the time before the history stays empty.
  const slots = Math.max(range ? rangeSlots(range) : days.length, days.length);
  return (
    <div
      role="img"
      aria-label={`Uptime, ${days.length} bars`}
      className={cn("grid items-stretch gap-[2px]", tall ? "h-9" : "h-6", className)}
      style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}
    >
      {days.map((day, i) => (
        <span
          key={day.start}
          title={tickTitle(day, barMs, timeZone)}
          className={cn("min-w-0 rounded-[2px]", TICK_COLOR[tickTone(day)])}
          style={i === 0 ? { gridColumnStart: slots - days.length + 1 } : undefined}
        />
      ))}
    </div>
  );
}

/** The monitor's target. An HTTP target opens the site in a new tab; host:port stays text. */
export function TargetLink({ monitor, className }: { monitor: Pick<MonitorSummary, "check" | "target" | "openable">; className?: string }) {
  if (monitor.check.type !== "http" || !monitor.openable) return <span className={cn("truncate", className)}>{monitor.target}</span>;
  return (
    <a
      href={monitor.check.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(quietLinkClass, "relative z-10 inline-flex max-w-full items-center gap-1", className)}
    >
      <span className="truncate">{monitor.target}</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const TONE: Record<DisplayState, "good" | "issue" | "neutral" | "warn"> = { up: "good", degraded: "warn", down: "issue", unknown: "neutral", review: "warn", stopped: "neutral" };

export function StateMark({ state }: { state: DisplayState }) {
  return <StatusMark tone={TONE[state]} />;
}

export function StatePill({ state, downSince, children }: { state: DisplayState; downSince?: number | null; children?: ReactNode }) {
  return (
    <Chip tone={state === "up" ? "good" : state === "down" ? "issue" : state === "degraded" || state === "review" ? "warn" : "neutral"} caps={false}>
      {children ?? stateLabel(state, downSince ?? null)}
    </Chip>
  );
}

export function Tile({ label, value, sub, tone, pending = false }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; pending?: boolean }) {
  return (
    <div className="squircle grid gap-0.5 rounded-lg bg-card px-4 py-3 shadow-card dark:border">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {pending ? (
        <span className="text-sm leading-7 text-muted-foreground">{value}</span>
      ) : (
        <span className={cn("text-2xl font-semibold leading-[1.1] tracking-[-0.01em] tabular-nums", tone)}>{value}</span>
      )}
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}
