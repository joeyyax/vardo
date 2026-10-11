import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { StatusDot, StatusMark, type StatusDotTone } from "@/components/ui/status-dot";
import {
  formatAge,
  formatInterval,
  publicCronStatus,
  type PublicCronStatus,
  type PublicJobState,
} from "@/lib/cron/public-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Cron status" },
  robots: { index: false, follow: false },
};

const STATE: Record<PublicJobState, { tone: StatusDotTone; label: string; pending?: boolean }> = {
  failing: { tone: "issue", label: "Failing" },
  overdue: { tone: "warn", label: "Overdue" },
  never_run: { tone: "neutral", label: "Never run", pending: true },
  healthy: { tone: "good", label: "Healthy" },
};

function headline(s: PublicCronStatus): { tone: StatusDotTone; text: string } {
  if (!s.schedulerOk) return { tone: "issue", text: "Scheduler stopped" };
  if (s.failing || s.overdue) {
    const parts = [s.failing && `${s.failing} failing`, s.overdue && `${s.overdue} overdue`].filter(Boolean);
    return { tone: s.failing ? "issue" : "warn", text: parts.join(", ") };
  }
  if (s.jobs === 0) return { tone: "neutral", text: "No cron jobs" };
  return { tone: "good", text: "All jobs healthy" };
}

function schedulerLine(s: PublicCronStatus): string {
  if (s.schedulerAgeS === null) return "Scheduler hasn't ticked yet";
  return `Scheduler ticked ${formatAge(s.schedulerAgeS)} ago`;
}

export default async function CronStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const status = await publicCronStatus(token);
  if (!status) notFound();

  // Traefik's replacePath sets this when the page is served at a custom host's root.
  const onOwnHost = !!(await headers()).get("x-replaced-path");
  const jsonHref = onOwnHost ? "/status.json" : `/api/status/cron/${token}`;
  const head = headline(status);
  const stats = [
    { label: "Jobs", value: status.jobs },
    { label: "Healthy", value: status.healthy },
    { label: "Failing", value: status.failing },
    { label: "Never run", value: status.neverRun },
  ];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-10 sm:py-16">
      <meta httpEquiv="refresh" content="60" />
      <header className="grid gap-2">
        <p className="type-label text-muted-foreground">Cron status</p>
        <h1 className="type-h3 flex items-center gap-3">
          <span className="[&_svg]:size-5">
            <StatusMark tone={head.tone} />
          </span>
          {head.text}
        </h1>
        <p className={status.schedulerOk ? "text-sm text-muted-foreground" : "text-sm text-status-error"}>
          {schedulerLine(status)}
        </p>
      </header>

      <Card variant="surface" className="grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="grid gap-1 px-4 py-3">
            <span className="type-label text-muted-foreground">{s.label}</span>
            <span className="type-numeral text-2xl">{s.value}</span>
          </div>
        ))}
      </Card>

      {status.list.length > 0 && (
        <Card variant="surface" className="p-1.5">
          <ul aria-label="Jobs" className="grid">
            {status.list.map((job, i) => {
              const state = STATE[job.state];
              return (
                <li
                  key={i}
                  className="grid grid-cols-[1fr_auto_4.5rem] items-center gap-3 rounded-md px-3 py-2 text-sm"
                >
                  <StatusDot tone={state.tone} pending={state.pending}>
                    {state.label}
                  </StatusDot>
                  <span className="text-muted-foreground">
                    {job.intervalS === null ? "never fires" : formatInterval(job.intervalS)}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {job.lastRunAgeS === null ? "—" : `${formatAge(job.lastRunAgeS)} ago`}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <footer className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>Checked {status.checkedAt.slice(11, 19)} UTC</span>
        <span aria-hidden="true">·</span>
        <a href={jsonHref} className="underline-offset-4 hover:text-foreground hover:underline">
          JSON
        </a>
      </footer>
    </div>
  );
}
