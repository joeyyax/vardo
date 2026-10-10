"use client";

import { useEffect, useState, type ReactNode, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { StatusMark } from "@/components/ui/status-dot";
import type { Handled } from "@/components/fix-action";
import type { Problem } from "@/lib/ui/conditions";
import { formatAbsoluteDateTime, formatSpan } from "@/lib/ui/relative-time";
import { cn } from "@/lib/utils";

/** "For 3d", client-only so server and client never disagree. Re-labelled every 30 seconds. */
export function Since({ since }: { since: string | null }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!since) return;
    const tick = () => setText(formatSpan(since));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [since]);
  if (!since || !text) return null;
  return (
    <time dateTime={since} title={formatAbsoluteDateTime(since)}>
      For {text}
    </time>
  );
}

/** One kind of problem: a count, what it means and a bulk fix where one fits. */
export function IssueGroup({
  title,
  count,
  why,
  bulk,
  children,
}: {
  title: string;
  count: number;
  why: string;
  bulk?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-accent px-[7px] text-[12.5px] leading-[19px] text-muted-foreground tabular-nums">
          {count}
        </span>
        {bulk && <span className="ml-auto">{bulk}</span>}
      </div>
      <p className="text-[13px] text-muted-foreground">{why}</p>
      <div className="mt-0.5 grid gap-0.5">{children}</div>
    </section>
  );
}

/** One app with a problem: the cause, how long and the fix. Activating it opens the app. */
export function IssueItem({
  itemKey,
  name,
  where,
  problem,
  showTitle,
  selected = false,
  actions,
  onActivate,
}: {
  /** Identifies the item to the panel's keyboard handling. */
  itemKey: string;
  name: string;
  /** Project, and parent when nested. */
  where: string;
  problem: Problem;
  /** Off when the group heading already says it. */
  showTitle: boolean;
  selected?: boolean;
  actions?: ReactNode;
  onActivate: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-panel-item={itemKey}
      aria-label={`${name}: ${problem.title}`}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      className={cn(
        "grid cursor-pointer grid-cols-[12px_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 rounded-[10px] p-2.5 outline-none",
        "hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brass",
        selected && "bg-brass-muted",
      )}
    >
      <span className="mt-1">
        <StatusMark tone={problem.tone === "error" ? "issue" : "warn"} />
      </span>
      <div className="grid min-w-0 gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold">{name}</span>
          <span className="text-muted-foreground/70">{where}</span>
        </div>
        <div className="text-[13.5px]">
          {showTitle && (
            <>
              <span className={problem.tone === "error" ? "text-status-error" : "text-status-warning"}>{problem.title}</span>
              {problem.detail && " · "}
            </>
          )}
          {problem.detail}
        </div>
        {problem.since && (
          <div className="text-[12.5px] text-muted-foreground/70">
            <Since since={problem.since} />
          </div>
        )}
      </div>
      {actions && (
        <div className="col-start-2 flex flex-wrap items-center gap-1 pt-1.5" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** "N open across M projects · K handled just now", with a bar once something is handled. */
export function IssueProgress({ open, projects, handled }: { open: number; projects: number; handled: number }) {
  const total = open + handled;
  return (
    <div className="grid gap-2" role="status">
      <p className="text-sm text-muted-foreground">
        <b className="font-semibold text-foreground">{open}</b> open across {projects} project{projects === 1 ? "" : "s"}
        {handled > 0 && <span className="text-status-success"> · {handled} handled just now</span>}
      </p>
      {handled > 0 && (
        <div
          role="progressbar"
          aria-label="Handled"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={handled}
          className="h-1 overflow-hidden rounded-full bg-accent"
        >
          <i
            className="block h-full rounded-full bg-status-success transition-[width] duration-400 motion-reduce:transition-none"
            style={{ width: `${Math.round((handled / total) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function HandledList({ handled }: { handled: Handled[] }) {
  if (handled.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer py-1 text-[13px] text-muted-foreground">Handled just now · {handled.length}</summary>
      {handled.map((h, i) => (
        <div key={`${h.name}-${i}`} className="flex items-center gap-2 py-1 pl-0.5 text-[13px]">
          <span className="flex size-3 items-center justify-center rounded-full bg-status-success text-card">
            <Check className="size-2" strokeWidth={4} aria-hidden="true" />
          </span>
          <span>{h.displayName}</span>
          <span className="text-muted-foreground/70">
            {h.title.toLowerCase()}, {h.outcome}
          </span>
        </div>
      ))}
    </details>
  );
}

/** Nothing in the list. Says so plainly. */
export function AllClear({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="grid justify-items-center gap-1.5 px-3 py-7 text-center">
      <svg viewBox="0 0 48 48" aria-hidden="true" className="mb-1.5 size-12">
        <circle cx="24" cy="24" r="22" className="fill-status-success-muted stroke-status-success-edge" strokeWidth="1" />
        <path d="M15 24.5 21 30.5 33 18" fill="none" className="stroke-status-success" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h3 className="type-h3">{title}</h3>
      {detail && <p className="max-w-[34ch] text-[13.5px] text-muted-foreground">{detail}</p>}
    </div>
  );
}
