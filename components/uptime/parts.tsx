"use client";

import type { ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { StatusMark } from "@/components/ui/status-dot";
import { stateLabel, tickTitle, tickTone, type TickTone } from "@/lib/uptime/format";
import type { DayTick, MonitorState } from "@/lib/uptime/types";
import { cn } from "@/lib/utils";

const TICK_COLOR: Record<TickTone, string> = {
  up: "bg-status-success",
  partial: "bg-status-warning",
  down: "bg-status-error",
  none: "bg-muted",
};

/** One bar per day: green up, amber partial, red down, grey no data. */
export function DayTicks({ days, className, tall = false }: { days: DayTick[]; className?: string; tall?: boolean }) {
  return (
    <div role="img" aria-label={`Uptime for the last ${days.length} days`} className={cn("flex items-stretch gap-[2px]", tall ? "h-9" : "h-6", className)}>
      {days.map((day) => (
        <span key={day.start} title={tickTitle(day)} className={cn("min-w-0 flex-1 rounded-[2px]", TICK_COLOR[tickTone(day)])} />
      ))}
    </div>
  );
}

const TONE: Record<MonitorState, "good" | "issue" | "neutral"> = { up: "good", down: "issue", unknown: "neutral" };

export function StateMark({ state }: { state: MonitorState }) {
  return <StatusMark tone={TONE[state]} />;
}

export function StatePill({ state, downSince, children }: { state: MonitorState; downSince?: number | null; children?: ReactNode }) {
  return (
    <Chip tone={state === "up" ? "good" : state === "down" ? "issue" : "neutral"} caps={false}>
      {children ?? stateLabel(state, downSince ?? null)}
    </Chip>
  );
}

export function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="squircle grid gap-0.5 rounded-lg bg-card px-4 py-3 shadow-card dark:border">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className={cn("text-2xl font-semibold leading-[1.1] tracking-[-0.01em] tabular-nums", tone)}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}
