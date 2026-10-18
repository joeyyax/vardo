"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusMark } from "@/components/ui/status-dot";
import { JOB_STEPS, type JobKind, type PipelineSnapshot } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import { PipelineLoops } from "./pipeline-loops";
import { clock, span } from "./timeline";

const KIND: Record<JobKind, string> = { backup: "Backup", drill: "Restore drill", cron: "Cron run" };
const HREF: Record<JobKind, string> = { backup: "/backups", drill: "/backups", cron: "/cron" };

function Line({ tone, children, link }: { tone: "issue" | "warn" | "neutral"; children: React.ReactNode; link?: { label: string; href: string } }) {
  return (
    <div className="flex items-start gap-2 py-1.5 text-[13.5px]">
      <span className="mt-1">
        <StatusMark tone={tone} />
      </span>
      <span className={cn("min-w-0 flex-1", tone === "issue" && "text-status-error", tone === "warn" && "text-status-warning")}>{children}</span>
      {link ? (
        <Link href={link.href} className="ml-auto shrink-0 text-[13px] text-muted-foreground underline decoration-foreground/20 underline-offset-[3px] hover:text-foreground">
          {link.label}
        </Link>
      ) : null}
    </div>
  );
}

export function PipelineJobs({ snapshot, now }: { snapshot: PipelineSnapshot; now: number }) {
  const [showLoops, setShowLoops] = useState(false);
  const running = snapshot.jobs.filter((j) => j.finishedAt === null);
  const overdue = snapshot.overdue ?? [];
  const next = (snapshot.upcoming ?? [])[0];
  const loops = snapshot.loops.flatMap((g) => g.loops).filter((l) => l.enabled);
  const failing = loops.filter((l) => l.failed);
  const late = loops.filter((l) => l.stale && !l.failed);

  return (
    <Card variant="surface" className="p-5">
      <h2 className="type-h4 mb-2.5">Jobs and loops</h2>
      {running.length > 0 ? (
        <>
          <div className="mb-1 type-label text-muted-foreground">Jobs running</div>
          {running.map((j) => (
            <Link key={j.id} href={HREF[j.kind]} className="squircle grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-1.5 py-2 hover:bg-row-hover">
              <StatusMark tone="signal" pending />
              <span className="min-w-0">
                <span className="block truncate">{j.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {KIND[j.kind]} · {JOB_STEPS[j.kind][j.step]}
                </span>
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{clock(now - j.startedAt)}</span>
            </Link>
          ))}
          <div className="mt-3.5 mb-1 type-label text-muted-foreground">Up next</div>
        </>
      ) : null}
      {overdue.map((o) => (
        <Line key={o.name} tone="warn" link={{ label: "Backups", href: "/backups" }}>
          {o.name} backup last ran {span(now - o.at)} ago
        </Line>
      ))}
      {next ? (
        <Line tone="neutral" link={running.length || overdue.length ? undefined : { label: next.kind === "cron" ? "Cron" : "Backups", href: HREF[next.kind] }}>
          Next: {next.name} {KIND[next.kind].toLowerCase()} in {span(Math.max(1000, next.at - now))}
        </Line>
      ) : running.length === 0 && overdue.length === 0 ? (
        <Line tone="neutral">Nothing scheduled</Line>
      ) : null}

      <div className="mt-3.5 mb-1 flex items-center type-label text-muted-foreground">
        Background loops
        <Button size="xs" variant="ghost" className="ml-auto normal-case tracking-normal" aria-expanded={showLoops} onClick={() => setShowLoops((v) => !v)}>
          {showLoops ? "Hide" : `Show all ${loops.length}`}
        </Button>
      </div>
      {failing.map((l) => (
        <Line key={l.name} tone="issue" link={{ label: "This instance", href: "/admin/settings/general" }}>
          {l.label} failing
        </Line>
      ))}
      {late.map((l) => (
        <Line key={l.name} tone="warn" link={{ label: "This instance", href: "/admin/settings/general" }}>
          {l.label} late{l.lastTickAt ? ` · last ran ${span(now - l.lastTickAt)} ago` : ""}
        </Line>
      ))}
      {failing.length === 0 && late.length === 0 ? <Line tone="neutral">All {loops.length} loops on schedule</Line> : null}
      {showLoops ? (
        <div className="mt-3">
          <PipelineLoops groups={snapshot.loops} now={now} />
        </div>
      ) : null}
    </Card>
  );
}
