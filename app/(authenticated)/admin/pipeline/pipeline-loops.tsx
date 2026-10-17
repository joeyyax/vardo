"use client";

import type { LoopGroup, PipelineLoop } from "@/lib/pipeline/loops";
import { cn } from "@/lib/utils";

/** Clean passes write a heartbeat at most this often, so faster loops show their schedule, not each pass. */
const HEARTBEAT_GAP_MS = 15_000;
/** A loop pulses for this long after it records a pass; snapshots arrive every few seconds. */
const PULSE_MS = 5_000;

export function span(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** How far through its interval a loop is, and when it runs next. */
export function loopProgress(loop: PipelineLoop, now: number): { share: number; next: string } {
  if (!loop.enabled) return { share: 0, next: "off" };
  if (loop.intervalMs === null || loop.lastTickAt === null) return { share: 0, next: "not yet" };
  const elapsed = Math.max(0, now - loop.lastTickAt);
  if (elapsed <= loop.intervalMs) return { share: elapsed / loop.intervalMs, next: `in ${span(loop.intervalMs - elapsed)}` };
  if (loop.intervalMs < HEARTBEAT_GAP_MS && elapsed < HEARTBEAT_GAP_MS * 3) {
    const into = elapsed % loop.intervalMs;
    return { share: into / loop.intervalMs, next: `in ${span(loop.intervalMs - into)}` };
  }
  return { share: 1, next: loop.stale ? "stalled" : "due" };
}

function LoopRow({ loop, now }: { loop: PipelineLoop; now: number }) {
  const { share, next } = loopProgress(loop, now);
  const pulsing = loop.lastTickAt !== null && now - loop.lastTickAt < PULSE_MS;
  const title = loop.failed && loop.lastError ? `Last run failed: ${loop.lastError}` : undefined;
  return (
    <li
      className={cn("grid grid-cols-[minmax(0,1fr)_2rem_2.5rem_3.5rem] items-center sm:grid-cols-[minmax(0,1fr)_2.5rem_4.5rem_4rem] gap-2 border-b py-1", !loop.enabled && "opacity-50")}
      title={title}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full transition-colors duration-700",
            loop.failed ? "bg-status-error" : pulsing ? "bg-status-success duration-0" : "bg-border",
          )}
        />
        <span className="truncate">{loop.label}</span>
      </span>
      <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
        {loop.intervalMs === null ? "–" : span(loop.intervalMs)}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
        <span
          className={cn("block h-full rounded-full", loop.failed ? "bg-status-error" : "bg-muted-foreground")}
          style={{ width: `${(share * 100).toFixed(1)}%` }}
        />
      </span>
      <span className={cn("text-right font-mono text-xs tabular-nums", loop.failed ? "text-status-error" : "text-muted-foreground")}>
        {loop.failed ? "failed" : next}
      </span>
    </li>
  );
}

export function PipelineLoops({ groups, now }: { groups: LoopGroup[]; now: number }) {
  if (groups.length === 0) return <p className="text-sm text-muted-foreground">No loops have reported yet.</p>;

  return (
    <div className="grid gap-x-8 gap-y-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))]">
      {groups.map((g) => (
        <div key={g.label} className="min-w-0">
          <h3 className="mb-1.5 text-sm font-semibold">{g.label}</h3>
          <ul>
            {g.loops.map((l) => (
              <LoopRow key={l.name} loop={l} now={now} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
