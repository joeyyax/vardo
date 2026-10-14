"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useAttention } from "@/components/attention-provider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusMark } from "@/components/ui/status-dot";
import { VARDO_UPDATING_ROW_KEY } from "@/lib/attention/vardo-update-row";
import { chipLabel, systemProblems, workerLines, type SystemProblem, type WorkerOutage } from "@/lib/ui/system-status";
import { cn } from "@/lib/utils";

/** "4:12 PM" today, "Oct 13, 4:12 PM" before. */
function clockTime(iso: string): string {
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  return at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Mark({ problem }: { problem: SystemProblem | undefined }) {
  if (!problem) return <StatusMark tone="good" />;
  if (problem.kind === "worker") return <StatusMark tone="warn" pending />;
  return <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
}

function ProblemNote({ problem }: { problem: SystemProblem }) {
  if (problem.kind === "worker") {
    return (
      <div className="grid gap-1">
        <p className="font-medium">{problem.since ? `Worker offline since ${clockTime(problem.since)}.` : "Worker offline."}</p>
        {workerLines(problem).map((line) => (
          <p key={line} className="text-muted-foreground">
            {line}
          </p>
        ))}
        {problem.queued > 0 && (
          <Link href="/projects?panel=deploying" className="w-fit font-medium underline underline-offset-2 hover:no-underline">
            See queued deploys
          </Link>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      {problem.href ? (
        <Link href={problem.href} className="w-fit font-medium underline underline-offset-2 hover:no-underline">
          {problem.name}
        </Link>
      ) : (
        <p className="font-medium">{problem.name}</p>
      )}
      <p className="text-muted-foreground">Deployed apps keep running.</p>
    </div>
  );
}

/** Vardo's own health by the branding: a quiet dot, or a chip naming the worst problem. */
export function SystemStatus({ worker: initial, version }: { worker: WorkerOutage | null; version: string }) {
  const { rows, loaded, worker: live } = useAttention();
  // The layout's reading until the attention poll answers.
  const worker = loaded ? live : initial;
  const updating = rows.find((r) => r.key === VARDO_UPDATING_ROW_KEY)?.items[0] ?? null;
  const problems = systemProblems(worker, updating && { name: updating.name, href: updating.href });
  const worst = problems[0];
  const label = worst ? chipLabel(worst) : null;

  return (
    <>
      {/* Always mounted, so a change is announced and the first reading isn't. */}
      <span role="status" className="sr-only">
        {label ? label.full : "Running normally"}
      </span>
      <Popover>
        <PopoverTrigger
          aria-label={label ? `System status: ${label.full}` : "System status: running normally"}
          className={cn(
            "relative inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-medium after:absolute after:-inset-1.5 focus-visible:outline-2 focus-visible:outline-brass pointer-fine:after:hidden",
            label ? "border bg-card px-2.5 hover:bg-accent" : "hover:bg-sidebar-accent/50",
          )}
        >
          <Mark problem={worst} />
          {label && (
            <>
              <span aria-hidden="true" className="truncate sm:hidden">
                {label.short}
              </span>
              <span aria-hidden="true" className="hidden truncate sm:inline">
                {label.full}
              </span>
            </>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-auto max-w-[min(20rem,calc(100vw-2rem))] gap-3 text-[13px]">
          {problems.length ? (
            problems.map((p) => <ProblemNote key={p.kind} problem={p} />)
          ) : (
            <div className="grid gap-1">
              <p className="font-medium">Running normally</p>
              <p className="text-muted-foreground">{version}</p>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
