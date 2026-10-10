"use client";

import { useId } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { Term, TermScope } from "@/components/term";
import { useStoredFlag } from "@/hooks/use-stored-flag";
import { formatBytes, formatCores, formatMemLimit } from "@/lib/metrics/format";
import { describeCoreTotals } from "@/lib/metrics/core-services";
import type { ServerBreakdown } from "@/lib/metrics/server-groups";

const COLUMNS = "grid-cols-[1fr_90px_90px_80px_80px]";
const ROW = `grid ${COLUMNS} gap-3 px-4 items-center whitespace-nowrap min-w-[560px]`;
const NUM = "text-xs text-right tabular-nums text-muted-foreground";

function Skeleton() {
  return <span className="inline-block h-3.5 w-10 rounded bg-muted animate-pulse align-middle" />;
}

/** One collapsible group, closed by default. The open state is kept per viewer. */
function Group({ storageId, title, summary, awaiting, children }: {
  storageId: string;
  title: React.ReactNode;
  summary: React.ReactNode;
  awaiting: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useStoredFlag(`vardo:metrics:group:${storageId}`);
  const regionId = useId();

  return (
    <Card variant="surface" className="overflow-x-auto">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-accent/50"
      >
        <DisclosureChevron open={open} />
        <h3 className="type-h4">{title}</h3>
        <span className="text-xs text-muted-foreground tabular-nums sm:ml-auto">
          {awaiting ? <Skeleton /> : summary}
        </span>
      </button>
      {open && <div id={regionId}>{children}</div>}
    </Card>
  );
}

function Header({ first }: { first: string }) {
  return (
    <div className={`${ROW} py-2 bg-background-deep text-xs text-muted-foreground`}>
      <span>{first}</span>
      <span className="text-right">CPU</span>
      <span className="text-right">Memory</span>
      <span className="text-right">Limit</span>
      <span className="text-right">Containers</span>
    </div>
  );
}

function totalsLine(t: { cpu: number; memory: number; containers: number }) {
  return `${formatBytes(t.memory)} · ${formatCores(t.cpu)} · ${t.containers} container${t.containers === 1 ? "" : "s"}`;
}

/** The whole server broken down by organization, project and app, with Vardo's own services as a group. */
export function ServerBreakdownView({ breakdown, awaiting }: { breakdown: ServerBreakdown; awaiting: boolean }) {
  const { orgs, core } = breakdown;
  const cell = (content: React.ReactNode) => (awaiting ? <Skeleton /> : content);

  return (
    <div className="space-y-4">
      {orgs.map((org) => (
        <Group
          key={org.id}
          storageId={`org:${org.id}`}
          title={org.name}
          summary={totalsLine(org)}
          awaiting={awaiting}
        >
          <Header first="Project / app" />
          {org.projects.map((project) => (
            <div key={project.id}>
              <div className={`${ROW} py-2 border-t bg-muted/30`}>
                <span className="text-xs font-medium truncate">{project.name}</span>
                <span className={NUM}>{cell(formatCores(project.cpu))}</span>
                <span className={NUM}>{cell(formatBytes(project.memory))}</span>
                <span />
                <span className={NUM}>{cell(project.containers)}</span>
              </div>
              <div className="divide-y">
                {project.apps.map((a) => (
                  <Link
                    key={a.id}
                    href={`/apps/${a.appName}/metrics`}
                    className={`${ROW} py-3 hover:bg-accent/50 transition-colors`}
                  >
                    <div className="flex items-center gap-3 min-w-0 pl-4">
                      <span className={`size-2 rounded-full shrink-0 ${a.isActive ? "bg-status-success" : "bg-status-neutral"}`} />
                      <span className="text-sm font-medium truncate">{a.name}</span>
                    </div>
                    <span className={NUM}>{cell(a.containers > 0 ? formatCores(a.cpu) : "-")}</span>
                    <span className={NUM}>{cell(a.memory > 0 ? formatBytes(a.memory) : "-")}</span>
                    <span className={NUM}>{cell(a.limit > 0 ? formatMemLimit(a.limit) : "-")}</span>
                    <span className={NUM}>{cell(a.containers)}</span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </Group>
      ))}

      {(awaiting || core.rows.length > 0) && (
        <Group
          storageId="vardo"
          title={<Term id="core-vardo" passive>Vardo</Term>}
          summary={describeCoreTotals(core.totals)}
          awaiting={awaiting}
        >
          <TermScope>
            <Header first="Service" />
            <div className="divide-y">
              {core.rows.map((r) => (
                <div key={r.key} className={`${ROW} py-3`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="size-2 rounded-full shrink-0 bg-status-success" />
                    <span className="text-sm font-medium truncate">
                      {r.term ? <Term id={r.term}>{r.label}</Term> : r.label}
                    </span>
                  </div>
                  <span className={NUM}>{cell(formatCores(r.cpu))}</span>
                  <span className={NUM}>{cell(r.memory > 0 ? formatBytes(r.memory) : "-")}</span>
                  <span className={NUM}>{cell(r.limit > 0 ? formatMemLimit(r.limit) : "-")}</span>
                  <span className={NUM}>{cell(r.containers)}</span>
                </div>
              ))}
            </div>
          </TermScope>
        </Group>
      )}
    </div>
  );
}
