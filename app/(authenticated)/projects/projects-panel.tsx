"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusMark } from "@/components/ui/status-dot";
import { PanelSection } from "@/components/detail-panel";
import { DeployProgress } from "@/components/deploy-progress";
import { FixButton, type FixTarget, type Handled, type RunAction } from "@/components/fix-action";
import { AllClear, HandledList, IssueGroup, IssueItem, IssueProgress, Since } from "@/components/issue-group";
import { RelativeTime } from "@/components/relative-time";
import type { AppMetrics, MetricsHistory } from "@/components/app-metrics-card";
import { formatBytes, formatCores, formatMemLimit } from "@/lib/metrics/format";
import type { Problem } from "@/lib/ui/conditions";
import { typicalElapsedMs } from "@/lib/ui/deploy-timing";
import { SERVICE_KIND_LABEL } from "@/lib/ui/service-kind";
import { statusMarkTone } from "@/lib/ui/status-colors";
import {
  appsIn,
  issueGroups,
  markSubject,
  problemOf,
  walk,
  PANEL_TITLE,
  type Located,
  type PanelKey,
  type Section,
  type TreeNode,
} from "@/lib/ui/projects";
import { fixTarget, RowMenu, Sparkline, usageOf } from "./project-list";

export type PanelContext = {
  orgId: string;
  sections: Section[];
  selected: string | null;
  busy: ReadonlySet<string>;
  handled: Handled[];
  run: (target: FixTarget, action: RunAction, fixing?: Problem) => void;
  jump: (name: string) => void;
  open: (name: string) => void;
  metrics: Map<string, AppMetrics>;
  history: Map<string, MetricsHistory>;
  cpuCount: number | null;
};

function where(loc: Located): string {
  const parent = loc.node.parent?.displayName;
  return parent ? `${loc.project.displayName} / ${parent}` : loc.project.displayName;
}

function FixActions({ loc, problem, ctx, primary = false }: { loc: Located; problem: Problem; ctx: PanelContext; primary?: boolean }) {
  const fix = problem.fix;
  const runs = fix && "run" in fix ? fix.run : null;
  return (
    <>
      {fix && (
        <FixButton
          fix={fix}
          size={primary ? "sm" : "xs"}
          variant={primary ? "default" : "outline"}
          busy={runs ? ctx.busy.has(fixTarget(loc.node, runs).name) : false}
          onRun={() => runs && ctx.run(fixTarget(loc.node, runs), runs, problem)}
        />
      )}
      <Button asChild size={primary ? "sm" : "xs"} variant="ghost">
        <Link href={problem.look.href}>{problem.look.label}</Link>
      </Button>
    </>
  );
}

function IssuesBody({ ctx, only }: { ctx: PanelContext; only?: "backups" }) {
  const groups = issueGroups(ctx.sections, only);
  const items = groups.flatMap((g) => g.items);
  if (items.length === 0) {
    return (
      <>
        {only === "backups" ? (
          <AllClear title="Backups are current" detail="Every app with data has a good backup." />
        ) : (
          <AllClear
            title="Nothing needs attention"
            detail={`Every app is running as expected.${ctx.handled.length ? ` You handled ${ctx.handled.length} just now.` : ""}`}
          />
        )}
        <HandledList handled={ctx.handled} />
      </>
    );
  }
  const projects = new Set(items.map((i) => i.project.id)).size;
  return (
    <>
      <IssueProgress open={items.length} projects={projects} handled={ctx.handled.length} />
      {groups.map((g) => {
        const fixable = g.items.filter((i) => i.problem.fix && "run" in i.problem.fix);
        const bulk =
          g.meta.bulk && fixable.length > 1 ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                fixable.forEach((i) => {
                  const runs = (i.problem.fix as { run: RunAction }).run;
                  ctx.run(fixTarget(i.node, runs), runs, i.problem);
                })
              }
            >
              {g.meta.bulk} {fixable.length === 2 ? "both" : `all ${fixable.length}`}
            </Button>
          ) : undefined;
        return (
          <IssueGroup key={g.key} title={g.meta.title} count={g.items.length} why={g.meta.why} bulk={bulk}>
            {g.items.map((i) => (
              <IssueItem
                key={i.node.app.id}
                itemKey={i.node.app.name}
                name={i.node.app.displayName}
                where={where(i)}
                problem={i.problem}
                showTitle={i.problem.title !== g.meta.title}
                selected={ctx.selected === i.node.app.name}
                onActivate={() => ctx.jump(i.node.app.name)}
                actions={<FixActions loc={i} problem={i.problem} ctx={ctx} />}
              />
            ))}
          </IssueGroup>
        );
      })}
      <HandledList handled={ctx.handled} />
    </>
  );
}

function DeployCard({ loc, ctx }: { loc: Located; ctx: PanelContext }) {
  const app = loc.node.app;
  const running = app.deployments.find((d) => d.status === "running" || d.status === "queued");
  return (
    <div
      role="button"
      tabIndex={0}
      data-panel-item={app.name}
      aria-label={`${app.displayName}, deploying`}
      onClick={() => ctx.jump(app.name)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          ctx.jump(app.name);
        }
      }}
      className="squircle grid cursor-pointer gap-2.5 rounded-md bg-background-deep p-3.5 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brass"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="motion-safe:animate-pulse">
          <StatusMark tone="info" pending />
        </span>
        <span className="font-semibold">{app.displayName}</span>
        <span className="text-muted-foreground/70">{where(loc)}</span>
        {running?.gitSha && <span className="ml-auto font-mono text-xs text-muted-foreground/70">{running.gitSha.slice(0, 7)}</span>}
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <DeployProgress
          orgId={ctx.orgId}
          appId={app.id}
          appName={app.name}
          startedAt={running?.startedAt ?? new Date()}
          typicalMs={typicalElapsedMs(app.deployments)}
        />
      </div>
    </div>
  );
}

function DeployingBody({ ctx }: { ctx: PanelContext }) {
  const deploying = appsIn(ctx.sections, "deploying");
  if (deploying.length === 0) {
    const last = ctx.sections
      .flatMap((s) => s.nodes.map((n) => ({ app: n.app, d: n.app.deployments.find((d) => d.status === "success") })))
      .filter((x) => x.d)
      .sort((a, b) => new Date(b.d!.startedAt).getTime() - new Date(a.d!.startedAt).getTime())[0];
    return (
      <AllClear
        title="Nothing is deploying"
        detail={last ? `The last deploy was ${last.app.displayName}.` : undefined}
      />
    );
  }
  return (
    <div className="grid gap-2.5">
      {deploying.map((loc) => (
        <DeployCard key={loc.node.app.id} loc={loc} ctx={ctx} />
      ))}
    </div>
  );
}

function StateBody({ ctx, kind }: { ctx: PanelContext; kind: "running" | "stopped" }) {
  const list = appsIn(ctx.sections, kind);
  if (list.length === 0) {
    return kind === "running" ? (
      <AllClear title="Nothing is running" />
    ) : (
      <AllClear title="Nothing is stopped" detail="Every app is meant to be running." />
    );
  }
  const byProject = new Map<string, Located[]>();
  for (const loc of list) byProject.set(loc.project.id, [...(byProject.get(loc.project.id) ?? []), loc]);
  return (
    <>
      {[...byProject.values()].map((locs) => (
        <IssueGroupless key={locs[0].project.id} title={locs[0].project.displayName} count={locs.length}>
          {locs.map((loc) => (
            <SlimItem key={loc.node.app.id} loc={loc} ctx={ctx} right={kind === "stopped" ? "stopped by you" : undefined} />
          ))}
        </IssueGroupless>
      ))}
    </>
  );
}

function IssueGroupless({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-accent px-[7px] text-[12.5px] leading-[19px] text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="grid gap-0.5">{children}</div>
    </section>
  );
}

function SlimItem({ loc, ctx, right }: { loc: Located; ctx: PanelContext; right?: string }) {
  const app = loc.node.app;
  const mark = statusMarkTone(markSubject(loc.node));
  return (
    <div
      role="button"
      tabIndex={0}
      data-panel-item={app.name}
      onClick={() => ctx.jump(app.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ctx.jump(app.name);
        }
      }}
      className="flex cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brass"
    >
      <StatusMark tone={mark.tone} pending={mark.pending} />
      <span className="font-semibold">{app.displayName}</span>
      <span className="min-w-0 truncate text-muted-foreground/70">{app.domains[0] ?? ""}</span>
      <span className="ml-auto shrink-0 text-[12.5px] text-muted-foreground/70">
        {right ?? (app.containerStartedAt ? <Since since={new Date(app.containerStartedAt).toISOString()} /> : null)}
      </span>
    </div>
  );
}

/** The list a page stat opens. */
export function PanelList({ panel, ctx }: { panel: PanelKey; ctx: PanelContext }) {
  switch (panel) {
    case "attention":
      return <IssuesBody ctx={ctx} />;
    case "backups":
      return <IssuesBody ctx={ctx} only="backups" />;
    case "deploying":
      return <DeployingBody ctx={ctx} />;
    case "running":
    case "stopped":
      return <StateBody ctx={ctx} kind={panel} />;
  }
}

function relatedOf(loc: Located, sections: Section[]): { label: string; node: TreeNode; note: string }[] {
  const { node } = loc;
  const out: { label: string; node: TreeNode; note: string }[] = [];
  const all = sections.flatMap((s) => walk(s.nodes));
  const find = (name: string) => all.find((n) => n.app.name === name);
  if (node.parent) {
    const parent = find(node.parent.name);
    if (parent) out.push({ label: node.relation === "service" ? "Part of" : "Used by", node: parent, note: node.relation === "service" ? "compose app" : "separate app" });
  }
  for (const child of node.children) {
    out.push({ label: child.relation === "service" ? "Service" : "Uses", node: child, note: child.relation === "dependency" ? "separate app" : "" });
  }
  const shown = new Set(out.map((r) => r.node.app.name));
  for (const dep of node.app.dependsOn ?? []) {
    const n = find(dep);
    if (n && !shown.has(dep)) {
      out.push({ label: node.relation === "service" ? "Needs" : "Uses", node: n, note: "" });
      shown.add(dep);
    }
  }
  for (const n of all) {
    if (!shown.has(n.app.name) && (n.app.dependsOn ?? []).includes(node.app.name)) {
      out.push({ label: "Used by", node: n, note: "" });
      shown.add(n.app.name);
    }
  }
  return out;
}

function deployMark(status: string) {
  return status === "failed" ? <StatusMark tone="issue" /> : status === "running" || status === "queued" ? <StatusMark tone="info" pending /> : <StatusMark tone="good" />;
}

/** One app: a status sentence, one primary action, two numbers, then Related and Deploys. */
export function AppDetail({ loc, ctx }: { loc: Located; ctx: PanelContext }) {
  const { node } = loc;
  const app = node.app;
  const p = problemOf(node) ?? walk(node.children).map(problemOf).find(Boolean) ?? null;
  const mark = statusMarkTone(markSubject(node));
  const stopped = app.parked || app.status === "stopped";
  const usage = app.status === "active" || app.status === "deploying" ? usageOf(node, ctx.metrics, ctx.history) : null;
  const related = relatedOf(loc, ctx.sections);
  const running = app.deployments.find((d) => d.status === "running" || d.status === "queued");
  const primaryAction: RunAction = stopped || node.relation === "service" ? "restart" : "deploy";
  const primaryLabel = stopped ? "Start" : node.relation === "service" ? "Restart" : "Deploy";

  return (
    <>
      <div className="flex items-baseline gap-2 text-sm">
        <span className="translate-y-px">
          <StatusMark tone={mark.tone} pending={mark.pending} />
        </span>
        <span className="grid gap-0.5">
          {p ? (
            <>
              <span className={p.tone === "error" ? "text-status-error" : "text-status-warning"}>{p.title}</span>
              {(p.detail || p.since) && (
                <span className="text-muted-foreground">
                  {p.detail}
                  {p.detail && p.since && " · "}
                  {p.since && <Since since={p.since} />}
                </span>
              )}
            </>
          ) : stopped ? (
            <span className="text-muted-foreground">Stopped by you. Vardo leaves it down until you start it.</span>
          ) : app.status === "deploying" ? (
            <span className="text-status-info">Deploying</span>
          ) : (
            <span className="text-muted-foreground">
              Running{app.containerStartedAt && <> · <Since since={new Date(app.containerStartedAt).toISOString()} /></>}
            </span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {p ? (
          <FixActions loc={loc} problem={p} ctx={ctx} primary />
        ) : app.status === "deploying" ? (
          <Button asChild size="sm">
            <Link href={`/apps/${app.name}/deployments`}>View deploy</Link>
          </Button>
        ) : (
          <FixButton
            fix={{ label: primaryLabel, run: primaryAction }}
            size="sm"
            variant="default"
            busy={ctx.busy.has(fixTarget(node, primaryAction).name)}
            onRun={() => ctx.run(fixTarget(node, primaryAction), primaryAction)}
          />
        )}
        {p?.look.label !== "View logs" && (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/apps/${app.name}/logs`}>Logs</Link>
          </Button>
        )}
        <RowMenu node={node} ctx={ctx} />
      </div>

      {running && (
        <DeployProgress
          orgId={ctx.orgId}
          appId={app.id}
          appName={app.name}
          startedAt={running.startedAt}
          typicalMs={typicalElapsedMs(app.deployments)}
        />
      )}

      {usage && (
        <div className="grid gap-2.5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[22px] leading-[1.1] font-semibold tabular-nums">{formatCores(usage.cpu)}</div>
              <div className="text-[12.5px] text-muted-foreground">CPU{ctx.cpuCount ? ` of ${ctx.cpuCount} host cores` : ""}</div>
            </div>
            <div>
              <div className="text-[22px] leading-[1.1] font-semibold tabular-nums">
                {formatBytes(usage.memory)}
                {usage.memoryLimit > 0 && (
                  <small className="text-[13px] font-normal text-muted-foreground"> of {formatMemLimit(usage.memoryLimit)}</small>
                )}
              </div>
              <div className="text-[12.5px] text-muted-foreground">memory</div>
            </div>
          </div>
          {usage.series.length > 1 && (
            <div className="grid gap-1">
              <Sparkline data={usage.series} w={376} h={48} className="h-12 w-full text-[var(--chart-cpu)]" />
              <span className="text-xs text-muted-foreground">CPU, last hour</span>
            </div>
          )}
        </div>
      )}

      <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted-foreground">Image</dt>
        <dd className="font-mono text-xs [overflow-wrap:anywhere]">
          {app.imageName ?? (app.services.length ? `compose · ${app.services.length} services` : app.gitUrl ? "built from source" : "—")}
        </dd>
        {app.domains[0] && (
          <>
            <dt className="text-muted-foreground">Domain</dt>
            <dd className="[overflow-wrap:anywhere]">{app.domains[0]}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Deployed</dt>
        <dd>
          {app.deployments[0] ? (
            <span className="inline-flex items-baseline gap-1.5">
              {app.deployments[0].gitSha && <span className="font-mono text-xs">{app.deployments[0].gitSha.slice(0, 7)}</span>}
              <RelativeTime date={app.deployments[0].startedAt} className="text-muted-foreground" />
            </span>
          ) : node.relation === "service" && node.parent ? (
            `with ${node.parent.displayName}`
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-muted-foreground">Backups</dt>
        <dd>
          {app.lastBackupAt ? (
            <span className="text-muted-foreground">
              last good <RelativeTime date={app.lastBackupAt} />
            </span>
          ) : (
            <span className="text-muted-foreground/70">none on record</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{SERVICE_KIND_LABEL[app.kind]}</dd>
        {app.priority === "critical" && (
          <>
            <dt className="text-muted-foreground">Priority</dt>
            <dd>Critical</dd>
          </>
        )}
      </dl>

      {related.length > 0 && (
        <PanelSection title="Related">
          <div className="grid gap-0.5">
            {related.map((r) => {
              const m = statusMarkTone(markSubject(r.node));
              return (
                <button
                  key={`${r.label}-${r.node.app.id}`}
                  type="button"
                  data-panel-item={r.node.app.name}
                  onClick={() => ctx.jump(r.node.app.name)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-accent"
                >
                  <span className="w-16 shrink-0 text-[12.5px] text-muted-foreground/70">{r.label}</span>
                  <StatusMark tone={m.tone} pending={m.pending} />
                  <span>{r.node.app.displayName}</span>
                  <span className="ml-auto text-[12.5px] text-muted-foreground/70">{r.note}</span>
                </button>
              );
            })}
          </div>
        </PanelSection>
      )}

      {app.deployments.length > 0 && (
        <PanelSection title="Deploys">
          <div className="grid text-[13px]">
            {app.deployments.map((d, i) => (
              <div key={d.id} className="flex items-center gap-2.5 py-1">
                {deployMark(d.status)}
                <span className="font-mono text-xs">{d.gitSha ? d.gitSha.slice(0, 7) : d.trigger ?? "deploy"}</span>
                <RelativeTime date={d.startedAt} className="text-muted-foreground" />
                <span
                  className={
                    d.status === "failed"
                      ? "ml-auto text-status-error"
                      : d.status === "running" || d.status === "queued"
                        ? "ml-auto text-status-info"
                        : "ml-auto text-muted-foreground/70"
                  }
                >
                  {d.status === "success" ? (i === 0 ? "live" : "") : d.status.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>
        </PanelSection>
      )}

      <Link href={`/apps/${app.name}`} className="w-fit text-[13px] text-muted-foreground hover:text-foreground">
        Open app page →
      </Link>
    </>
  );
}

/** "← Needs attention", back from an app to the list it was opened from. */
export function BackLink({ panel, onBack }: { panel: PanelKey; onBack: () => void }) {
  return (
    <button
      type="button"
      data-back
      onClick={onBack}
      className="mb-1.5 flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      {PANEL_TITLE[panel]}
    </button>
  );
}
