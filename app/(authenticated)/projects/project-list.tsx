"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { AppRow } from "@/components/app-row";
import { DomainLink, EntityLink } from "@/components/entity-link";
import { appHref, deployHref, projectHref } from "@/lib/ui/hrefs";
import { ListRow } from "@/components/list-row";
import { SectionHeader, SectionNumber } from "@/components/section-header";
import { SystemBadge } from "@/components/system-badge";
import { FixButton, type FixTarget, type RunAction } from "@/components/fix-action";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppMetrics, MetricsHistory } from "@/components/app-metrics-card";
import { compactUptime, sourceRef, sparkPath } from "@/lib/ui/app-row";
import type { Problem } from "@/lib/ui/conditions";
import { formatBytes, formatCores } from "@/lib/metrics/format";
import { RelativeTime } from "@/components/relative-time";
import { statusMarkTone } from "@/lib/ui/status-colors";
import { markSubject, problemOf, walk, type Section, type TreeNode } from "@/lib/ui/projects";
import { termForText, type GlossaryId } from "@/lib/ui/glossary";
import { Term } from "@/components/term";
import { cn } from "@/lib/utils";

/** Rows shown before "Show N more". */
const ROW_LIMIT = 8;

export type ListContext = {
  dense: boolean;
  query: string;
  selected: string | null;
  flash: string | null;
  isProjectOpen: (projectId: string) => boolean;
  isAppOpen: (node: TreeNode, section: Section) => boolean;
  showsAll: (projectId: string) => boolean;
  toggleProject: (projectId: string) => void;
  toggleApp: (name: string) => void;
  showAll: (projectId: string) => void;
  open: (name: string) => void;
  busy: ReadonlySet<string>;
  run: (target: FixTarget, action: RunAction, fixing?: Problem) => void;
  metrics: Map<string, AppMetrics>;
  history: Map<string, MetricsHistory>;
  updatesByApp: Map<string, number>;
  matches: (node: TreeNode, section: Section) => boolean;
};

export type Usage = { cpu: number; memory: number; memoryLimit: number; series: number[] } | null;

/** Live usage for a row: its own containers, or the sum of its services. */
export function usageOf(node: TreeNode, metrics: Map<string, AppMetrics>, history: Map<string, MetricsHistory>): Usage {
  const own = metrics.get(node.app.id);
  if (own) return { cpu: own.cpuPercent, memory: own.memoryUsage, memoryLimit: own.memoryLimit, series: history.get(node.app.id)?.cpu ?? [] };
  const parts = node.app.services.map((s) => ({ m: metrics.get(s.id), h: history.get(s.id)?.cpu ?? [] })).filter((p) => p.m);
  if (parts.length === 0) return null;
  const len = Math.max(...parts.map((p) => p.h.length));
  return {
    cpu: parts.reduce((n, p) => n + p.m!.cpuPercent, 0),
    memory: parts.reduce((n, p) => n + p.m!.memoryUsage, 0),
    memoryLimit: parts.reduce((n, p) => n + p.m!.memoryLimit, 0),
    series: Array.from({ length: len }, (_, i) => parts.reduce((n, p) => n + (p.h[i] ?? 0), 0)),
  };
}

/** Who runs a fix: a deploy of a service runs on its compose app. */
export function fixTarget(node: TreeNode, action: RunAction): FixTarget {
  const app = action === "deploy" && node.relation === "service" && node.parent ? node.parent : node.app;
  return { id: app.id, name: app.name, displayName: app.displayName };
}

export function Sparkline({ data, w = 56, h = 16, className }: { data: number[]; w?: number; h?: number; className?: string }) {
  const path = sparkPath(data, w, h);
  if (!path) return null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" className={className}>
      <path d={path.d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={path.end[0]} cy={path.end[1]} r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Client-only so server and client never disagree. */
function Uptime({ since }: { since: Date | string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setText(compactUptime(since));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [since]);
  return text ? <>up {text}</> : null;
}

function signalOf(node: TreeNode, expanded: boolean | undefined): ReactNode {
  const app = node.app;
  const parentDomain = node.parent?.domains[0];
  const domain = app.domains[0] && app.domains[0] !== parentDomain ? app.domains[0] : null;
  const image = app.imageName ? sourceRef(app)?.replace(/^.*\//, "") : app.gitUrl ? "built from source" : null;
  const bits: string[] = [];
  if (!domain && image) bits.push(image);
  if (node.relation === "dependency") bits.push("dependency");
  if (expanded === false && node.children.length) {
    bits.push(app.services.length ? `${app.services.length} services` : `${node.children.length} linked`);
  }
  const rest = bits.join(" · ");
  if (!domain) return rest;
  return (
    <>
      <DomainLink domain={domain} tabIndex={-1} className="max-w-full align-bottom hover:text-foreground" />
      {rest && ` · ${rest}`}
    </>
  );
}

function toneClass(p: Problem) {
  return p.tone === "error" ? "text-status-error" : "text-status-warning";
}

/** The row's menu: open, deploy, restart, visit, logs. */
export function RowMenu({ node, ctx }: { node: TreeNode; ctx: Pick<ListContext, "open" | "run" | "busy"> }) {
  const app = node.app;
  const domain = app.domains[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          data-row-menu
          aria-label={`Actions for ${app.displayName}`}
          className="flex size-[26px] items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => ctx.open(app.name)}>Open details</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/apps/${app.name}`}>Open app page</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={ctx.busy.has(app.name)} onSelect={() => ctx.run(fixTarget(node, "deploy"), "deploy")}>
          {node.relation === "service" ? `Deploy ${node.parent?.displayName}` : "Deploy"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={ctx.busy.has(app.name)} onSelect={() => ctx.run(fixTarget(node, "restart"), "restart")}>
          {app.parked || app.status === "stopped" ? "Start" : "Restart"}
        </DropdownMenuItem>
        {domain && (
          <DropdownMenuItem asChild>
            <a href={`https://${domain}`} target="_blank" rel="noreferrer">
              Visit {domain}
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/apps/${app.name}/logs`}>View logs</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Status text in a row, explained on hover without adding a tab stop. */
function RowTerm({ text, id }: { text: string; id?: GlossaryId }) {
  const term = id ?? termForText(text);
  return term ? (
    <Term id={term} passive>
      {text}
    </Term>
  ) : (
    text
  );
}

function ComfortableRows({ section, nodes, depth, ctx }: { section: Section; nodes: TreeNode[]; depth: number; ctx: ListContext }) {
  const shown = nodes.filter((n) => ctx.matches(n, section));
  return (
    <>
      {shown.map((node, i) => {
        const app = node.app;
        const kids = node.children.filter((c) => ctx.matches(c, section));
        const expanded = kids.length ? ctx.isAppOpen(node, section) : undefined;
        const p = problemOf(node);
        const quietParent = node.relation === "service" && node.parent?.status === app.status && app.status !== "active";
        const inner = !p && expanded === false ? walk(node.children).map((c) => [c, problemOf(c)] as const).find(([, cp]) => cp) : null;
        const stopped = app.parked || app.status === "stopped";
        const usage = app.status === "active" || app.status === "deploying" ? usageOf(node, ctx.metrics, ctx.history) : null;
        const status = p ? (
          <span className={toneClass(p)}>
            <RowTerm text={p.title} />
          </span>
        ) : inner ? (
          <span className={toneClass(inner[1]!)}>
            {inner[0].app.displayName}: {inner[1]!.title.toLowerCase()}
          </span>
        ) : app.status === "deploying" && !quietParent ? (
          <span className="text-status-info">
            <RowTerm text="Deploying" />
          </span>
        ) : stopped && !quietParent ? (
          <span className="text-muted-foreground/70">
            <RowTerm text="Stopped" id={app.parked ? "parked" : "stopped"} />
          </span>
        ) : app.status === "active" && app.containerStartedAt ? (
          <span className="text-muted-foreground/70 tabular-nums">
            <Uptime since={app.containerStartedAt} />
          </span>
        ) : null;

        return (
          <div key={app.id} role="none">
            <ListRow
              navKey={app.name}
              mark={statusMarkTone(markSubject(node))}
              name={app.displayName}
              nameTitle={app.name}
              href={appHref(app.name)}
              signal={signalOf(node, expanded)}
              status={status}
              action={
                p?.fix ? (
                  <FixButton
                    fix={p.fix}
                    tabIndex={-1}
                    busy={ctx.busy.has(fixTarget(node, "run" in p.fix ? p.fix.run : "deploy").name)}
                    onRun={() => "run" in p.fix! && ctx.run(fixTarget(node, p.fix!.run), p.fix!.run, p)}
                  />
                ) : undefined
              }
              metrics={
                usage ? (
                  <>
                    <Sparkline data={usage.series} className={p ? toneClass(p) : "text-muted-foreground/50"} />
                    <span className="min-w-[4.5rem] text-right tabular-nums">{formatCores(usage.cpu)}</span>
                    <span className="min-w-[4rem] text-right tabular-nums">{formatBytes(usage.memory)}</span>
                  </>
                ) : undefined
              }
              menu={<RowMenu node={node} ctx={ctx} />}
              depth={depth}
              last={i === shown.length - 1}
              dashed={node.relation === "dependency"}
              expanded={expanded}
              onToggle={() => ctx.toggleApp(app.name)}
              selected={ctx.selected === app.name}
              dim={stopped}
              flash={ctx.flash === app.name}
              onOpen={() => ctx.open(app.name)}
            />
            {expanded && <ComfortableRows section={section} nodes={kids} depth={depth + 1} ctx={ctx} />}
          </div>
        );
      })}
    </>
  );
}

function DenseRows({ section, nodes, depth, ctx }: { section: Section; nodes: TreeNode[]; depth: number; ctx: ListContext }) {
  const shown = nodes.filter((n) => ctx.matches(n, section));
  return (
    <>
      {shown.map((node, i) => {
        const kids = node.children.filter((c) => ctx.matches(c, section));
        const expanded = kids.length ? ctx.isAppOpen(node, section) : false;
        const app = node.app;
        return (
          <div key={app.id} role="none" className={cn("rounded-md", depth > 1 && "pl-5", ctx.flash === app.name && "animate-row-flash")}>
            <AppRow
              app={{ ...app, domains: app.domains.map((d) => ({ domain: d })) }}
              href={`/apps/${app.name}`}
              series={ctx.history.get(app.id)?.cpu}
              updateCount={ctx.updatesByApp.get(app.id) ?? 0}
              sharedStatus={node.relation === "service" ? node.parent?.status : null}
              indented={depth > 0}
              connector={{ last: i === shown.length - 1, dashed: node.relation === "dependency" }}
              related={ctx.selected === app.name}
              data-nav={app.name}
              aria-expanded={kids.length ? expanded : undefined}
              aria-current={ctx.selected === app.name ? "true" : undefined}
              tabIndex={-1}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                ctx.open(app.name);
              }}
              trailing={
                kids.length ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => ctx.toggleApp(app.name)}
                    className="px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {expanded ? "Hide" : app.services.length ? `${app.services.length} services` : `${kids.length} linked`}
                  </button>
                ) : undefined
              }
            />
            {expanded && <DenseRows section={section} nodes={kids} depth={depth + 1} ctx={ctx} />}
          </div>
        );
      })}
    </>
  );
}

function SectionNumbers({ section, ctx }: { section: Section; ctx: ListContext }) {
  const s = section.stats;
  const notUp = s.down;
  const usage = section.nodes
    .map((n) => usageOf(n, ctx.metrics, ctx.history))
    .filter((u): u is NonNullable<Usage> => !!u);
  const cpu = usage.reduce((n, u) => n + u.cpu, 0);
  const memory = usage.reduce((n, u) => n + u.memory, 0);
  const len = Math.max(0, ...usage.map((u) => u.series.length));
  const series = Array.from({ length: len }, (_, i) => usage.reduce((n, u) => n + (u.series[i] ?? 0), 0));
  const problemTone = s.critical ? "text-status-error" : "text-status-warning";

  return (
    <>
      <SectionNumber>
        <span>
          <b className="font-medium text-muted-foreground tabular-nums">{s.up}</b> of {s.total} up
          {notUp > 0 && <span className={problemTone}> · {notUp} down</span>}
          {s.stopped > 0 && ` · ${s.stopped} stopped`}
        </span>
      </SectionNumber>
      {s.issues > 0 && (
        <SectionNumber tone={problemTone}>
          {s.issues} open issue{s.issues === 1 ? "" : "s"}
        </SectionNumber>
      )}
      {s.deploying > 0 && <SectionNumber tone="text-status-info">{s.deploying} deploying</SectionNumber>}
      {s.latestDeploy && s.latestDeploy.status !== "running" && s.latestDeploy.status !== "queued" && (
        <SectionNumber optional tone={s.latestDeploy.status === "failed" ? "text-status-error" : undefined}>
          <EntityLink href={deployHref(s.latestDeploy.appName, s.latestDeploy.id)} className="hover:text-foreground">
            {s.latestDeploy.status === "failed" ? "deploy failed" : "deployed"}{" "}
            <RelativeTime date={s.latestDeploy.startedAt} className="font-medium tabular-nums" />
          </EntityLink>
        </SectionNumber>
      )}
      {s.backups > 0 && (
        <SectionNumber optional tone={s.backupsOverdue ? "text-status-warning" : undefined}>
          {s.backupsOverdue ? (
            `${s.backupsOverdue} backup${s.backupsOverdue === 1 ? "" : "s"} overdue`
          ) : s.lastBackupAt ? (
            <>
              backed up <RelativeTime date={s.lastBackupAt} className="font-medium tabular-nums" />
            </>
          ) : null}
        </SectionNumber>
      )}
      {usage.length > 0 && (
        <SectionNumber optional title="CPU and memory now">
          <Sparkline data={series} className={s.critical ? "text-status-error" : "text-muted-foreground/50"} />
          <span>
            <b className="font-medium tabular-nums">{formatCores(cpu)}</b> · <b className="font-medium tabular-nums">{formatBytes(memory)}</b>
          </span>
        </SectionNumber>
      )}
    </>
  );
}

/** Every project as a section: a header row and, when open, its apps. */
export function ProjectList({ sections, ctx }: { sections: Section[]; ctx: ListContext }) {
  return (
    <div role="tree" aria-label="Projects" className={cn("grid", ctx.dense ? "gap-1" : "gap-1")}>
      {sections.map((section) => {
        const { project } = section;
        const open = ctx.isProjectOpen(project.id);
        const roots = section.nodes.filter((n) => ctx.matches(n, section));
        const all = ctx.query || ctx.showsAll(project.id) || roots.length <= ROW_LIMIT + 2;
        const shown = all ? roots : roots.slice(0, ROW_LIMIT);
        return (
          <div key={project.id} role="none" className={cn("grid", open && "mt-1.5 mb-3.5")}>
            <SectionHeader
              navKey={`project:${project.id}`}
              title={project.displayName}
              href={projectHref(project.name)}
              badge={project.isSystemManaged ? <SystemBadge compact className="shrink-0" /> : undefined}
              expanded={open}
              onToggle={() => ctx.toggleProject(project.id)}
            >
              <SectionNumbers section={section} ctx={ctx} />
            </SectionHeader>
            {open && (
              <Card variant="surface" role="group" className={cn("mt-0.5", ctx.dense ? "px-1.5 py-1.5" : "p-1.5")}>
                {roots.length === 0 ? (
                  <Link href={`/apps/new?project=${project.id}`} className="block px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground">
                    No apps yet. Add one
                  </Link>
                ) : ctx.dense ? (
                  <div className="@container grid content-start">
                    <DenseRows section={section} nodes={shown} depth={0} ctx={ctx} />
                  </div>
                ) : (
                  <ComfortableRows section={section} nodes={shown} depth={0} ctx={ctx} />
                )}
                {!all && (
                  <button
                    type="button"
                    onClick={() => ctx.showAll(project.id)}
                    className="px-3 pt-2.5 pb-1.5 pl-[38px] text-left text-[13px] text-muted-foreground hover:text-foreground"
                  >
                    Show {roots.length - ROW_LIMIT} more
                  </button>
                )}
              </Card>
            )}
          </div>
        );
      })}
    </div>
  );
}
